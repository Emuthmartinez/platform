/**
 * ============================================================================
 * Mantenimiento de `failed_submissions`: retención y supresión (Ley 1581).
 * ============================================================================
 *
 * `lib/failed-submission.ts` CAPTURA (nunca lanza, corre en el catch de un
 * route). Este módulo es la otra mitad, la que faltaba al crear la tabla:
 *
 *  1. RETENCIÓN — la tabla guarda datos personales crudos (ese es su punto),
 *     así que no puede acumularlos indefinidamente. El cron de reconciliación
 *     la drena en cada tick:
 *       - filas ya reinyectadas (`replayed_at` no nulo): se borran a los 7
 *         días — su dato ya vive en la tabla destino.
 *       - filas pendientes: se borran a los 30 días, CON aviso ruidoso — a
 *         esa edad ya nadie las va a reinyectar y retenerlas es exposición
 *         sin beneficio. El log es la señal de que se renuncia a ese dato.
 *       - backlog pendiente con más de 24h: WARN en cada tick. "Nadie drena
 *         esta tabla" fue un hallazgo del incidente del 2026-08-11; este
 *         aviso es el que evita que se repita en silencio.
 *
 *  2. SUPRESIÓN — al resolver una solicitud de eliminación de datos (Ley
 *     1581), los envíos fallidos de esa persona también deben desaparecer:
 *     su nombre/contacto puede estar en un `payload` que nunca llegó a la
 *     tabla destino. Se busca por email (la clave distintiva del formulario
 *     de supresión); el nombre a secas es demasiado ambiguo y borrar el
 *     envío pendiente de OTRA persona sería perder SU dato.
 */
import { and, isNotNull, isNull, lt, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { colombiaTenantScope } from "@/lib/colombia-tenant";
import { sqlOwnsIncidentOrLegacyNull } from "@/tenant/ownership";
import type { TenantScope } from "@/tenant/scope";

const { failedSubmissions } = schema;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Reinyectadas: el dato ya está en la tabla destino; 7 días de margen forense. */
export const RETENTION_REPLAYED_MS = 7 * DAY_MS;

/** Pendientes: pasado un mes nadie las reinyecta; retenerlas es solo riesgo. */
export const RETENTION_UNREPLAYED_MS = 30 * DAY_MS;

/** Edad a partir de la cual un backlog pendiente merece un WARN por tick. */
export const PENDING_BACKLOG_WARN_MS = 1 * DAY_MS;

export interface RetentionDrainResult {
  replayedPurged: number;
  unreplayedPurged: number;
  /** Filas pendientes (sin reinyectar) que siguen en la tabla tras el drenaje. */
  pendingBacklog: number;
}

/**
 * Drenaje de retención. Idempotente y barato (DELETEs acotados por fecha en
 * una tabla que normalmente está vacía); lo llama el cron de reconciliación
 * en cada tick. Nunca debe tumbar al cron: el caller decide si loguear o
 * relanzar.
 */
export async function drainFailedSubmissionsRetention(
  now: number = Date.now(),
  scope: TenantScope = colombiaTenantScope(),
): Promise<RetentionDrainResult> {
  const db = await getDb();
  const tenantPredicate = sqlOwnsIncidentOrLegacyNull(scope);

  const replayed = await db
    .delete(failedSubmissions)
    .where(
      and(
        isNotNull(failedSubmissions.replayedAt),
        lt(failedSubmissions.replayedAt, now - RETENTION_REPLAYED_MS),
        tenantPredicate,
      ),
    )
    .returning({ id: failedSubmissions.id });

  const unreplayed = await db
    .delete(failedSubmissions)
    .where(
      and(
        isNull(failedSubmissions.replayedAt),
        lt(failedSubmissions.createdAt, now - RETENTION_UNREPLAYED_MS),
        tenantPredicate,
      ),
    )
    .returning({ id: failedSubmissions.id });

  if (unreplayed.length > 0) {
    // Renunciar a un envío pendiente = aceptar que ese dato se perdió. Se dice
    // con todas las letras, igual que hace la captura cuando falla.
    console.warn(
      `[failed-submissions] retención: se descartan ${unreplayed.length} envío(s) ` +
        `PENDIENTES con más de ${RETENTION_UNREPLAYED_MS / DAY_MS} días sin reinyectar.`,
    );
  }

  const backlogRows = await db
    .select({ createdAt: failedSubmissions.createdAt })
    .from(failedSubmissions)
    .where(and(isNull(failedSubmissions.replayedAt), tenantPredicate));
  const pendingBacklog = backlogRows.length;
  const stale = backlogRows.filter((r) => Number(r.createdAt) < now - PENDING_BACKLOG_WARN_MS);
  if (stale.length > 0) {
    console.warn(
      `[failed-submissions] backlog: ${stale.length} envío(s) pendientes con más de 24h ` +
        `sin reinyectar (total pendientes: ${pendingBacklog}). Alguien tiene que drenarlos.`,
    );
  }

  return {
    replayedPurged: replayed.length,
    unreplayedPurged: unreplayed.length,
    pendingBacklog,
  };
}

/**
 * Supresión Ley 1581: borra todo envío fallido cuyo payload contenga el email
 * dado (insensible a mayúsculas). Devuelve cuántos se borraron.
 *
 * Solo email a propósito: es la clave que identifica a la persona en la
 * solicitud de supresión y es lo bastante distintiva para no arrastrar envíos
 * de terceros. El payload es jsonb sin forma fija (cada formulario guarda lo
 * suyo), así que se busca sobre su serialización.
 */
export async function purgeFailedSubmissionsByEmail(email: string): Promise<number> {
  const needle = email.trim().toLowerCase();
  if (!needle) return 0;
  const db = await getDb();
  // Escapa los comodines de LIKE; el email va como parámetro (sin
  // interpolación cruda).
  const escaped = needle.replace(/([%_\\])/g, "\\$1");
  const rows = await db
    .delete(failedSubmissions)
    .where(sql`lower(${failedSubmissions.payload}::text) LIKE ${"%" + escaped + "%"}`)
    .returning({ id: failedSubmissions.id });
  if (rows.length > 0) {
    console.warn(
      `[failed-submissions] supresión Ley 1581: ${rows.length} envío(s) fallidos purgados.`,
    );
  }
  return rows.length;
}
