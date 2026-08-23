/**
 * Router `api/public/partner-sync` — ingesta síncrona de un socio externo hacia
 * `missing_persons`, para UN socio nombrado y vetted (no onboarding abierto).
 *
 * Por qué esto y no `worker/sync/` (fuentes externas) ni `worker/hub/`
 * (federación): ambos son asíncronos — encolan un job — y HOY no hay worker de
 * BullMQ/Valkey corriendo en el despliegue de Cloudflare Workers (ver
 * docs/modules.md, aviso de estado). Encolar ahí en staging/prod devuelve 202
 * pero nadie lo consume. Este router es una ruta Express síncrona normal, así
 * que funciona en el stack desplegado HOY sin depender de esa migración de
 * colas. Reutiliza el núcleo de dedup/upsert probado de `worker/sync`
 * (`service.upsertExternalMissingBatch`, dedup real por índice único
 * `(source, external_id)`, cero migración) en vez de reinventarlo.
 *
 * Capacidad: reutiliza `missing:create` (NO mintea una capability nueva — el
 * seed de capacidades solo corre en el job de migración, gateado a humanos).
 * `source` NUNCA sale del body: se deriva del email de la sesión que autenticó
 * la llamada (misma sesión que crea la API key vía `apikey:manage`), igual que
 * `stampActor` en hospital-supplies.router — permitir que el body declare su
 * propio `source` dejaría a un socio escribir bajo la identidad de otro.
 *
 * RESUELTO (U14 — "señal, no verdad"): una transición de `status` entrante en
 * un re-sync YA NO pisa el status guardado. `upsertExternalMissingBatch`
 * conserva el status local y crea una fila pendiente en
 * `record_status_signals` que un revisor (person:review) confirma o descarta
 * en el panel. Los campos no-status siguen con el merge COALESCE de siempre.
 * Con esto cae el bloqueante de producción que este comentario documentaba.
 *
 * Bloqueo de un socio problemático: `missing_person_suppressions` (source,
 * external_id) ya existe y `upsertExternalMissingBatch` ya la respeta — sirve
 * como kill-switch por registro. Revocar la API key es el kill-switch total.
 *
 * ENDURECIDO EN U13 (R23/R27):
 *  - `photoUrl`/`sourceUrl` se validan contra un allowlist de dominios POR
 *    SOCIO antes de guardarse (`@/config/partner-media-allowlist`). Motivo:
 *    `GET /api/missing/:id/photo` hace 302 a `photo_external_url` SIN validar
 *    su dominio (ver services/missing.ts `getMissingPhoto`) — sin este filtro,
 *    un socio podría convertir esa ruta pública en un open redirect hacia
 *    cualquier host. Dominio no permitido (o socio sin entrada en el
 *    allowlist, el caso por defecto) => el campo se guarda `null`; el
 *    registro se acepta igual, nunca se rechaza el batch por una foto.
 *  - `Idempotency-Key`: NO se implementa en esta fase. El idioma que usa
 *    `patient-imports.ts` (header opcional → persistir la key → reusar el
 *    resultado si se repite) depende de que el service de destino GUARDE esa
 *    key y sepa "reproducir" una respuesta ya calculada
 *    (`service.createImport` tiene esa columna + esa rama). `upsertExternalMissingBatch`
 *    no tiene ese concepto y añadírselo es tocar `services/missing.ts`, fuera
 *    del alcance de este endurecimiento. No es gratis reimplementarlo aquí
 *    solo para este router. Mitigante real: la escritura YA es idempotente
 *    por diseño en el caso que importa (reintentar un batch tras un timeout)
 *    — el upsert por `(source, external_id)` hace que re-enviar el mismo lote
 *    actualice en vez de duplicar, que es la garantía que un cliente de retry
 *    necesita. Lo que NO cubre (un reintento con datos YA cambiados en el
 *    medio no se distingue de un cambio real) es el mismo trade-off que ya
 *    acepta cualquier otra fuente de `upsertExternalMissingBatch` hoy.
 */
import { Router } from "express";
import { z } from "zod";
import { asyncHandler, rateLimit, validate } from "@/middleware";
import { requireCapability } from "@/middleware/auth";
import { writeAudit } from "@/auth/audit";
import { allowedPartnerMediaUrl } from "@/config/partner-media-allowlist";
import * as service from "@/services/missing";
import type { ExternalMissingInput } from "@/services/missing";
import { requireTenantScope } from "@/middleware/tenant";

export const partnerSyncRouter = Router();

/** Tope por llamada: esto corre SÍNCRONO en el request (sin cola), no es un batch job. */
const MAX_PEOPLE_PER_CALL = 50;

const partnerPersonSchema = z.object({
  // Id del socio para ESTA persona, dentro de SU sistema. Obligatorio: es la
  // mitad de la clave de dedup (source, external_id) — sin esto no hay forma
  // de reconciliar un re-sync sin duplicar.
  externalId: z.string().trim().min(1, "Falta el id de la persona en el sistema del socio.").max(200),
  name: z.string().trim().min(1, "Falta el nombre.").max(service.MAX_NAME),
  age: z.coerce.number().int().min(0).max(130).nullable().optional(),
  description: z.string().trim().max(service.MAX_DESCRIPTION).optional(),
  lastSeen: z.string().trim().max(service.MAX_LAST_SEEN).optional(),
  contact: z.string().trim().max(service.MAX_CONTACT).optional(),
  // Solo URL absoluta — igual que ExternalPerson, las integraciones no suben
  // foto en base64 por este camino.
  photoUrl: z.string().url().max(600).optional(),
  sourceUrl: z.string().url().max(300).optional(),
  status: z.enum(["active", "found"]).default("active"),
  resolutionNote: z.string().trim().max(service.MAX_RESOLUTION_NOTE).optional(),
  resolvedAt: z.number().int().positive().optional(),
  createdAt: z.number().int().positive().optional(),
});

const syncBody = z.object({
  people: z
    .array(partnerPersonSchema)
    .min(1, "Envía al menos un registro.")
    .max(MAX_PEOPLE_PER_CALL, `Máximo ${MAX_PEOPLE_PER_CALL} registros por llamada.`),
});

/** El `source` de un socio es SIEMPRE el email de la sesión que autenticó, nunca el body. */
function partnerSource(userEmail: string): string {
  return `partner:${userEmail.trim().toLowerCase()}`;
}

// ---------------------------------------------------------------------------
// POST /missing — upsert en lote de personas desaparecidas del socio
// ---------------------------------------------------------------------------
partnerSyncRouter.post(
  "/missing",
  rateLimit({ scope: "public:partner-sync:write", limit: 30 }),
  requireCapability("missing:create"),
  validate({ body: syncBody }),
  asyncHandler(async (req, res) => {
    const { people } = req.body as z.infer<typeof syncBody>;
    const source = partnerSource(req.user!.email);

    // Cuenta cuántas URLs de media se anularon por dominio no permitido — solo
    // un número en el audit (nunca la URL ni ningún dato de la persona).
    let mediaDropped = 0;
    const rows: ExternalMissingInput[] = people.map((p) => {
      const sourceUrl = allowedPartnerMediaUrl(source, p.sourceUrl ?? null);
      const photoUrl = allowedPartnerMediaUrl(source, p.photoUrl ?? null);
      if ((p.sourceUrl && !sourceUrl) || (p.photoUrl && !photoUrl)) mediaDropped++;
      return {
        externalId: p.externalId,
        source,
        sourceUrl,
        name: p.name,
        age: p.age ?? null,
        lastSeen: p.lastSeen,
        description: p.description,
        contact: p.contact,
        photoUrl,
        status: p.status,
        resolutionNote: p.resolutionNote ?? null,
        resolvedAt: p.resolvedAt ?? null,
        createdAt: p.createdAt ?? null,
      };
    });

    const result = await service.upsertExternalMissingBatch(rows, {
      scope: requireTenantScope(req),
    });

    await writeAudit(req, {
      action: "partner_sync.missing.upsert",
      targetType: "missing_person",
      targetId: source,
      metadata: { source, sent: people.length, mediaDropped, ...result },
    });

    res.json({ source, ...result });
  }),
);
