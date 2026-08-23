/**
 * Enrutado de Cron Triggers.
 *
 * Vive aparte de `src/worker.ts` a propósito: ese módulo crea un servidor HTTP
 * e importa `cloudflare:node` en ámbito de módulo, así que no se puede importar
 * desde un test. Sacando aquí la decisión de "qué expresión ejecuta qué", la
 * parte con lógica queda cubierta por tests y `worker.ts` se queda solo con el
 * cableado.
 *
 * Las expresiones son la FUENTE DE VERDAD y `backend/wrangler.jsonc` debe
 * declarar exactamente estas mismas. `test/cron-jobs.test.ts` compara las dos
 * para que un cambio en el JSON no deje un cron huérfano que no ejecuta nada.
 */
import {
  COLOMBIA_INCIDENT_ID,
  COLOMBIA_ORGANIZATION_ID,
  colombiaTenantScope,
} from "@/lib/colombia-tenant";
import type { TenantScope } from "@/tenant/scope";

/** Sync del catálogo de sismos (USGS). Ya en producción. */
export const CRON_EARTHQUAKES = "*/5 * * * *";

/**
 * Geocodificación de ubicaciones pendientes.
 *
 * Misma cadencia de 5 minutos que el sync de sismos pero DESFASADA dos minutos
 * (minutos 2, 7, 12, …). Dos motivos: `controller.cron` es la única forma de
 * distinguir un trigger de otro, así que dos expresiones idénticas serían
 * indistinguibles; y desfasarlas evita que las dos tareas compitan por el mismo
 * presupuesto de invocación.
 */
export const CRON_GEOCODE = "2-59/5 * * * *";

/**
 * Reconciliación de PRNs (U7, KTD8): estampa registros sin PRN (backfill en
 * sus primeras corridas; red de seguridad de la carrera del camino inline en
 * régimen permanente) y corre los invariantes de cluster de U9. Misma
 * cadencia de 5 minutos, DESFASADA dos minutos más que `CRON_GEOCODE` (y
 * cuatro que `CRON_EARTHQUAKES`) por el mismo motivo: `controller.cron` es lo
 * único que distingue un trigger de otro, así que las tres expresiones deben
 * ser distintas, y el desfase evita que compitan por el mismo presupuesto de
 * invocación.
 */
export const CRON_PERSON_RECONCILE = "4-59/5 * * * *";

/** Todas las expresiones que este Worker espera recibir. */
export const CRON_EXPRESSIONS = [
  CRON_EARTHQUAKES,
  CRON_GEOCODE,
  CRON_PERSON_RECONCILE,
] as const;

export type CronJobKind = "earthquakes" | "geocode" | "person-reconcile";

export const CRON_JOB_BY_EXPRESSION: Readonly<Record<string, CronJobKind>> = {
  [CRON_EARTHQUAKES]: "earthquakes",
  [CRON_GEOCODE]: "geocode",
  [CRON_PERSON_RECONCILE]: "person-reconcile",
};

/** All current crons fire every five minutes (offset expressions). */
export const CRON_WINDOW_MS = 5 * 60 * 1000;

export type CronHandler = (now: number) => Promise<void>;

export type CronOutcome = "ok" | "error" | "unhandled";

export interface DispatchCronOptions {
  organizationId?: string;
  incidentId?: string;
  onUnhandled?: (cron: string) => Promise<void>;
}

/**
 * Incidents this Worker enumerates for Cron. Today that is only Colombia.
 * One incident failure must not skip later incidents (U20).
 */
export function listCronIncidentScopes(): TenantScope[] {
  return [colombiaTenantScope()];
}

export function cronIdempotencyKey(input: {
  organizationId: string;
  incidentId: string;
  jobKind: string;
  scheduledTimeMs: number;
  windowMs?: number;
}): string {
  const windowMs = input.windowMs ?? CRON_WINDOW_MS;
  const windowStart = Math.floor(input.scheduledTimeMs / windowMs) * windowMs;
  return `cron:${input.organizationId}:${input.incidentId}:${input.jobKind}:${windowStart}`;
}

/**
 * Ejecuta el handler de una expresión cron.
 *
 * Una expresión desconocida NO lanza: Cloudflare reintentaría un trigger que
 * nunca va a coincidir. El outcome es `unhandled` (no un éxito silencioso) y
 * un callback opcional persiste la alerta.
 */
export async function dispatchCron(
  cron: string,
  now: number,
  handlers: Readonly<Record<string, CronHandler>>,
  options: DispatchCronOptions = {},
): Promise<CronOutcome> {
  const organizationId = options.organizationId ?? COLOMBIA_ORGANIZATION_ID;
  const incidentId = options.incidentId ?? COLOMBIA_INCIDENT_ID;
  const jobKind = CRON_JOB_BY_EXPRESSION[cron] ?? "unknown";
  const idempotencyKey = cronIdempotencyKey({
    organizationId,
    incidentId,
    jobKind,
    scheduledTimeMs: now,
  });

  const handler = handlers[cron];
  if (!handler) {
    console.error({
      t: "cron_run",
      cron,
      job_kind: jobKind,
      organization_id: organizationId,
      incident_id: incidentId,
      idempotency_key: idempotencyKey,
      outcome: "unhandled",
    });
    try {
      await options.onUnhandled?.(cron);
    } catch (err) {
      console.error(
        `[cron] no se pudo persistir la alerta de expresión desconocida:`,
        err instanceof Error ? err.message : String(err),
      );
    }
    return "unhandled";
  }

  const startedAt = performance.now();
  let outcome: Exclude<CronOutcome, "unhandled"> = "ok";
  try {
    await handler(now);
    return "ok";
  } catch (error) {
    outcome = "error";
    throw error;
  } finally {
    console.log({
      t: "cron_run",
      cron,
      job_kind: jobKind,
      organization_id: organizationId,
      incident_id: incidentId,
      idempotency_key: idempotencyKey,
      outcome,
      dur_ms: Math.round(performance.now() - startedAt),
    });
  }
}
