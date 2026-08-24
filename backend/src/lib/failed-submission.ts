/**
 * ============================================================================
 * Captura de ultimo recurso para un envio publico que no se pudo guardar.
 * ============================================================================
 *
 * POR QUE EXISTE: el 2026-08-11 el POST de voluntarios devolvio 503 durante ~6h
 * por una migracion sin aplicar. ~44 personas afectadas por el terremoto
 * rellenaron el formulario y su inscripcion se perdio: no llego a la base y no
 * quedo copia en ningun sitio. No habia NADA que reproducir despues.
 *
 * Los gates nuevos (deriva de esquema antes del deploy, monitor horario) hacen
 * eso mucho menos probable. Esto es la red por debajo: cuando la escritura
 * principal falla igualmente, el dato de la persona se guarda crudo en
 * `failed_submissions` y se puede reinyectar despues.
 *
 * ALCANCE HONESTO — leelo antes de confiar en esto:
 *
 *  - SI cubre el fallo de escritura sobre UNA tabla: deriva de esquema (el caso
 *    real), violacion de constraint, tipo incompatible. La tabla destino esta
 *    rota; `failed_submissions` no, porque su forma esta congelada.
 *  - NO cubre que la base entera este caida o inalcanzable. Ahi este insert
 *    falla tambien y el envio se pierde igual. Para eso haria falta un buffer
 *    fuera de Postgres (Queues/KV), que mueve PII a otro sistema y es una
 *    decision del mantenedor, no de este modulo.
 *
 * NUNCA LANZA. Corre dentro del `catch` de un route: si esto explotara,
 * enmascararia el error original y romperia el 503 que el usuario debe recibir.
 * Ante cualquier problema, loguea y se calla.
 *
 * PRIVACIDAD: `payload` guarda datos personales a proposito — es justo el dato
 * que la persona nos envio para que lo guardaramos, y perderlo es el daño que
 * este modulo evita. Se queda en la MISMA base y bajo las mismas protecciones
 * que la tabla destino; no se relocaliza a otro sistema. Se quita
 * `turnstileToken` (es un credencial de un solo uso, no un dato del formulario).
 */
import { getDb, schema } from "@/db";
import { describeDbError } from "@/lib/db-error";
import { incidentOwnership } from "@/tenant/ownership";
import type { TenantScope } from "@/tenant/scope";

const { failedSubmissions } = schema;

/** Claves que nunca se persisten: credenciales, no contenido del formulario. */
const STRIPPED = new Set(["turnstileToken", "token", "captcha"]);

function stripCredentials(payload: unknown): unknown {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(payload as Record<string, unknown>)) {
    if (!STRIPPED.has(k)) out[k] = v;
  }
  return out;
}

/**
 * SQLSTATE del error, si lo hay. Solo el codigo: el mensaje puede arrastrar los
 * valores de la fila (ver lib/db-error).
 */
function sqlstateOf(err: unknown): string | null {
  let cur: unknown = err;
  for (let i = 0; i < 5 && cur instanceof Error; i++) {
    const code = (cur as unknown as { code?: unknown }).code;
    if (typeof code === "string" && code) return code;
    cur = (cur as { cause?: unknown }).cause;
  }
  return null;
}

/**
 * Guarda el envio que no se pudo persistir. Devuelve true si quedo a salvo.
 *
 * `form` identifica el formulario ("volunteers", "missing", ...) y es lo que
 * usa el drenaje para saber a que tabla reinyectar.
 */
export async function captureFailedSubmission(
  form: string,
  payload: unknown,
  err: unknown,
  scope?: TenantScope | null,
): Promise<boolean> {
  try {
    if (!scope) {
      console.error(
        `[failed-submission] ${form}: NO TenantScope, envio no guardado, SE PIERDE.`,
      );
      return false;
    }
    const db = await getDb();
    await db.insert(failedSubmissions).values({
      id: crypto.randomUUID(),
      form,
      payload: stripCredentials(payload),
      errorCode: sqlstateOf(err),
      createdAt: Date.now(),
      replayedAt: null,
      ...incidentOwnership(scope),
    });
    console.warn(`[failed-submission] ${form}: envio guardado para reinyectar`);
    return true;
  } catch (captureErr) {
    // La red de seguridad tambien fallo (base caida, o esta tabla derivada).
    // Se dice explicitamente: este log es la unica señal de que se perdio un
    // envio de una persona real.
    console.error(
      `[failed-submission] ${form}: NO se pudo guardar el envio, SE PIERDE. ` +
        `causa=${describeDbError(captureErr)}`,
    );
    return false;
  }
}
