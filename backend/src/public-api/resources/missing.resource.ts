/**
 * Recurso `api/public/missing` — CONFIG declarativa sobre la fábrica CRUD.
 * Mismo patrón que `reports.resource.ts`: capacidad + esquemas zod + qué función
 * del service respalda cada verbo. La fábrica pone rate-limit, requireCapability,
 * validación y auditoría. La LÓGICA/DB sigue en `services/missing.ts`.
 *
 * Ops OMITIDAS a propósito:
 *   - La RESOLUCIÓN (marcar localizada / restaurar) NO va por `update`: tiene su
 *     propio flujo con nota obligatoria + foto-prueba (markMissingFound). Aquí
 *     `update` solo edita la ficha; status/foto/resolución no son editables.
 *
 * U12 — captura de cédula por staff (join key determinista del matcher, U8):
 *   - SOLO en `update` (PATCH, capacidad `missing:edit`): `create` sigue sin
 *     documento a propósito (la captura pública queda diferida, R10/R22).
 *   - `documentId` (crudo) se normaliza/hashea AQUÍ, igual que
 *     `patients.resource.ts` (misma `documentDigits`/`hashDocumentDigits` +
 *     `PATIENT_DOCUMENT_HASH_SECRET`) — el service SOLO recibe el HMAC.
 *   - A propósito SIN 409 por colisión de documento (KTD9): dos reportes con la
 *     misma cédula son señal de duplicado para el matcher, no un conflicto que
 *     bloquear (diferencia deliberada con patients.resource.ts).
 *   - `hasDocument`/`tipoDocumento` se exponen SOLO en este camino gated
 *     (get/list/update) vía `MissingAdminDTO` — `MissingDTO`/`rowToPerson`, el
 *     builder que también usan las rutas anónimas (`/api/missing`), quedan
 *     byte-idénticos. Mismo espíritu que el split `PatientDTO`/`PublicPatientDTO`
 *     de patients.ts, pero en la dirección opuesta: aquí el tipo COMPARTIDO es
 *     el público, y este archivo es el único que ve el superset.
 */
import { z } from "zod";
import { createCrudRouter, type CrudResource } from "@/public-api/crud-factory";
import { env } from "@/config/env";
import { badRequest, serviceUnavailable } from "@/lib/errors";
import { documentDigits, hashDocumentDigits } from "@/services/patient-import-logic";
import * as service from "@/services/missing";
import { tombstonePersonRecord } from "@/services/person-records";
import { requireTenantScope } from "@/middleware/tenant";
import { writeAudit } from "@/auth/audit";

/**
 * Cédula/documento CRUDO → HMAC, MISMA normalización y clave que
 * `patients.resource.ts` (`documentDigits` + `PATIENT_DOCUMENT_HASH_SECRET`):
 * un documento capturado aquí es joinable con `hospital_patients.document_hash`
 * — esa coincidencia es la señal fuerte del matcher (AE2). El crudo NUNCA baja
 * al service ni a la tabla. `null` = borrar el documento del reporte.
 */
function toDocumentHash(raw: string | null): string | null {
  if (raw === null) return null;
  const digits = documentDigits(raw);
  if (!digits) {
    throw badRequest(
      "Documento inválido: se esperan al menos 4 dígitos (se ignoran puntos y guiones).",
    );
  }
  const secret = env.PATIENT_DOCUMENT_HASH_SECRET;
  if (!secret) {
    throw serviceUnavailable(
      "PATIENT_DOCUMENT_HASH_SECRET no está configurado; no se puede guardar el documento.",
    );
  }
  return hashDocumentDigits(digits, secret);
}

// Edad opcional: número 0..130 (mismo rango que normalizeAge) o null para limpiarla.
const ageSchema = z.coerce.number().int().min(0).max(130).nullable();

// tipo_documento: catálogo cerrado (incluye "sin_documento" — confirmar que NO
// hay documento es un dato válido, distinto de "aún no preguntado" = null/ausente).
const tipoDocumentoSchema = z.enum(["CC", "TI", "CE", "PA", "RC", "NUIP", "sin_documento"]);

// Documento/cédula CRUDO de entrada: se convierte a HMAC en esta capa y jamás se
// persiste ni se devuelve. STRING a propósito (los ceros a la izquierda son
// reales); SIN validación de dígito de verificación (el único algoritmo
// conocido es el de NIT, no aplica a cédulas — ver plan U12).
const documentId = z.string().trim().min(1).max(60);

const createSchema = z.object({
  name: z.string().trim().min(1, "Indica el nombre.").max(service.MAX_NAME),
  age: ageSchema.optional(),
  nationality: z.string().trim().max(service.MAX_NATIONALITY).optional(),
  description: z.string().trim().max(service.MAX_DESCRIPTION).optional(),
  lastSeen: z.string().trim().max(service.MAX_LAST_SEEN).optional(),
  contact: z.string().trim().max(service.MAX_CONTACT).optional(),
  reportType: z.enum(["missing", "found"]).optional(),
});

const updateSchema = z
  .object({
    name: z.string().trim().min(1).max(service.MAX_NAME).optional(),
    age: ageSchema.optional(),
    nationality: z.string().trim().max(service.MAX_NATIONALITY).optional(),
    description: z.string().trim().max(service.MAX_DESCRIPTION).optional(),
    lastSeen: z.string().trim().max(service.MAX_LAST_SEEN).optional(),
    contact: z.string().trim().max(service.MAX_CONTACT).optional(),
    tipoDocumento: tipoDocumentoSchema.optional(),
    // `null` explícito borra el documento (mismo contrato que patients.resource.ts).
    documentId: documentId.nullable().optional(),
  })
  .refine((o) => Object.keys(o).length > 0, "Envía al menos un campo a actualizar.");

// DTO de SALIDA (lo que devuelve el service: MissingAdminDTO en este camino
// gated). Solo para documentar la forma del retorno en /api/docs.
const responseSchema = z.object({
  id: z.string(),
  name: z.string(),
  age: z.number().nullable(),
  nationality: z.string(),
  description: z.string(),
  lastSeen: z.string(),
  contact: z.string(),
  photoUrl: z.string().nullable(),
  status: z.enum(["active", "found"]),
  resolutionNote: z.string().nullable(),
  resolutionPhotoUrl: z.string().nullable(),
  resolvedAt: z.number().nullable(),
  createdAt: z.number(),
  // Presencia/tipo de documento (el HMAC ni el crudo se exponen jamás). SOLO en
  // este camino gated — las rutas anónimas (`/api/missing`) nunca lo devuelven.
  hasDocument: z.boolean().optional(),
  tipoDocumento: z.string().nullable().optional(),
});

export const missingResource: CrudResource<
  Awaited<ReturnType<typeof service.listMissingWithDocument>>[number],
  Awaited<ReturnType<typeof service.getMissingByIdWithDocument>>,
  z.infer<typeof createSchema>,
  z.infer<typeof updateSchema>
> = {
  capability: "missing",
  schemas: { create: createSchema, update: updateSchema, response: responseSchema },
  ops: {
    // Listado para integraciones: activas + localizadas, capado al tope de página.
    list: async () =>
      (await service.listMissingWithDocument({ includeFound: true })).slice(
        0,
        service.MAX_PAGE_SIZE,
      ),
    get: (id) => service.getMissingByIdWithDocument(id),
    create: (input, req) =>
      service.addMissing({
        name: input.name,
        age: input.age,
        nationality: input.nationality,
        description: input.description,
        lastSeen: input.lastSeen,
        contact: input.contact,
        photo: null, // las integraciones no suben base64 por este endpoint
        reportType: input.reportType,
      }, requireTenantScope(req)),
    update: (id, input) => {
      const { documentId, ...rest } = input;
      const documentHash =
        documentId === undefined ? undefined : toDocumentHash(documentId);
      return service.updateMissing(id, { ...rest, documentHash });
    },
    remove: (id, req) =>
      service.removeMissing(id, requireTenantScope(req)),
    // U10 (R21/AE3): tombstone de identidad ANTES del borrado físico —
    // insert-before-mutate, mismo orden que routes/missing.ts. Best-effort
    // (tombstonePersonRecord nunca lanza); req.user existe siempre aquí
    // (requireCapability autentica primero).
    onBeforeRemove: async (req, id) => {
      const tombstone = await tombstonePersonRecord("missing_report", id, req.user!.id);
      if (tombstone.prn) {
        await writeAudit(req, {
          action: "person.purge",
          targetType: "person_record",
          targetId: tombstone.prn,
        });
      }
    },
  },
};

export const publicMissingRouter = createCrudRouter(missingResource);
