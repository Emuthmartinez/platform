/**
 * Productor de la cola de publicación de necesidades.
 *
 * Ya no habla con BullMQ directamente: delega en el seam de despacho
 * (`@/lib/job-dispatch`), que elige transporte por capacidad — binding de
 * Cloudflare Queues si lo hay, BullMQ si hay VALKEY_URL. Los llamadores
 * (needs-module, needs-controller) no cambian.
 *
 * El import de bullmq/ioredis desapareció de este módulo A PROPÓSITO: estaba en
 * `src/`, así que entraba en el bundle de Workers aunque allí no pueda correr.
 */
import { createHash, randomUUID } from "crypto";
import { and, desc, eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import {
  dispatchJob,
  resolveTransport,
  valkeyUrl,
  type JobRoute,
} from "@/lib/job-dispatch";
import { serviceUnavailable } from "@/lib/errors";
import { incidentAuditOwnership, tenantJobFields } from "@/tenant/ownership";
import type { TenantScope } from "@/tenant/scope";
import type { NewNeed, ResolvedLocation } from "../domain/need";

export const NEEDS_PUBLICATION_QUEUE = "needs-publication";

/**
 * Binding declarado en wrangler.jsonc para el camino de Cloudflare Queues.
 * Mientras U2 no lo declare, `resolveTransport` simplemente no lo encuentra y
 * cae a BullMQ — que es el comportamiento de hoy.
 */
export const NEEDS_PUBLICATION_BINDING = "NEEDS_QUEUE";

export const needsPublicationRoute: JobRoute = {
  queueName: NEEDS_PUBLICATION_QUEUE,
  binding: NEEDS_PUBLICATION_BINDING,
};

export interface NeedPublicationJob {
  need: NewNeed;
  location?: ResolvedLocation;
  /** Correlación pública para el status poll (también viaja en Queues). */
  jobId?: string;
}

export interface NeedPublicationState {
  jobId: string;
  state: string;
  progress: unknown;
  result: { id: string; status: string } | null;
  failedReason: string | null;
}

function jobId(idempotencyKey?: string): string {
  if (!idempotencyKey) return `need-${randomUUID()}`;
  return `need-${createHash("sha256").update(idempotencyKey).digest("hex")}`;
}

const STATUS_ACTION = "need.publication.status";
const STATUS_TARGET = "need_publication";

type PersistedState = "queued" | "completed" | "failed";

function publicResult(result: unknown): { id: string; status: string } | null {
  if (typeof result !== "object" || result === null) return null;
  const candidate = result as { id?: unknown; status?: unknown };
  if (typeof candidate.id !== "string" || typeof candidate.status !== "string") {
    return null;
  }
  return { id: candidate.id, status: candidate.status };
}

/** Persiste solo estado y referencia pública; nunca el payload ciudadano. */
export async function recordNeedPublicationState(
  id: string,
  state: PersistedState,
  scope: TenantScope,
  options: { result?: unknown; failedReason?: string | null } = {},
): Promise<void> {
  await getDb()
    .insert(schema.auditLog)
    .values({
      actorUserId: null,
      action: STATUS_ACTION,
      targetType: STATUS_TARGET,
      targetId: id,
      metadata: {
        state,
        result: publicResult(options.result),
        failedReason: options.failedReason ?? null,
      },
      ipHash: null,
      createdAt: Date.now(),
      ...incidentAuditOwnership(scope),
    });
}

async function getPersistedState(
  id: string,
  scope: TenantScope,
): Promise<NeedPublicationState | null> {
  const rows = await getDb()
    .select({ metadata: schema.auditLog.metadata })
    .from(schema.auditLog)
    .where(
      and(
        eq(schema.auditLog.action, STATUS_ACTION),
        eq(schema.auditLog.targetType, STATUS_TARGET),
        eq(schema.auditLog.targetId, id),
        eq(schema.auditLog.organizationId, scope.organizationId),
        eq(schema.auditLog.incidentId, scope.incidentId),
      ),
    )
    .orderBy(desc(schema.auditLog.id))
    .limit(1);
  const metadata = rows[0]?.metadata as
    | { state?: unknown; result?: unknown; failedReason?: unknown }
    | undefined;
  if (!metadata || typeof metadata.state !== "string") return null;
  return {
    jobId: id,
    state: metadata.state,
    progress: metadata.state === "completed" ? 100 : null,
    result: publicResult(metadata.result),
    failedReason:
      typeof metadata.failedReason === "string" ? metadata.failedReason : null,
  };
}

export async function enqueueNeedPublication(
  data: NeedPublicationJob,
  scope: TenantScope,
  idempotencyKey?: string,
): Promise<string> {
  const id = jobId(idempotencyKey);
  const transport = resolveTransport(needsPublicationRoute);
  if (transport === "queues") await recordNeedPublicationState(id, "queued", scope);
  try {
    return await dispatchJob(
      needsPublicationRoute,
      { ...data, jobId: id, ...tenantJobFields(scope) },
      {
        id,
        attempts: 3,
        backoffMs: 10_000,
      },
    );
  } catch (error) {
    if (transport === "queues") {
      await recordNeedPublicationState(id, "failed", scope, {
        failedReason: "No se pudo encolar la publicación.",
      }).catch(() => undefined);
    }
    throw error;
  }
}

/**
 * Estado de una publicación.
 *
 * Tres casos distintos, que a proposito NO se colapsan en uno:
 *
 * - BullMQ: se consulta el registro de jobs y se devuelve el estado real.
 * - Cloudflare Queues: estado durable mínimo en `audit_log`, actualizado por el
 *   consumidor y el DLQ. No se persiste el payload ciudadano.
 * - SIN transporte: lanza 503. Antes de este seam, `queue()` lanzaba al faltar
 *   VALKEY_URL y el controlador lo convertia en 503. Devolver `null` aqui lo
 *   volveria un 404 "no encontrado", indistinguible de un jobId inexistente, y
 *   ocultaria un despliegue mal configurado detras de un error de usuario.
 */
export async function getNeedPublicationState(
  id: string,
  scope: TenantScope,
): Promise<NeedPublicationState | null> {
  const transport = resolveTransport(needsPublicationRoute);
  if (transport === "none") {
    throw serviceUnavailable(
      "La cola de publicación no está configurada en este despliegue.",
    );
  }
  if (transport === "queues") return getPersistedState(id, scope);
  // valkeyUrl() y no process.env directo: resolveTransport decide con
  // `process.env.VALKEY_URL || env.VALKEY_URL`, y leer solo la primera aqui
  // podria decir "bullmq" arriba y `null` una linea despues.
  const url = valkeyUrl();
  if (!url) return null;
  const { getBullmqJobState } = await import("@/lib/job-dispatch.bullmq");
  const state = await getBullmqJobState(needsPublicationRoute, id, url);
  if (!state) return null;
  if (
    state.organizationId !== scope.organizationId ||
    state.incidentId !== scope.incidentId
  ) {
    return null;
  }
  return { ...state, result: publicResult(state.result) };
}
