/**
 * Service del contador de clics de "ayuda psicosocial". CTE atómico de dedup
 * por IP + incremento + lectura en una sola sentencia (escape `sql`).
 *
 * Los identificadores van LITERALES, nunca como objetos columna de Drizzle:
 * interpolarlos los renderiza calificados ("tabla"."columna") y Postgres
 * rechaza esa forma en la lista de columnas del INSERT y en el LHS del SET
 * (42703 column "t" of relation "t" does not exist) — bug que dejó el
 * contador en 0 en producción. Los VALORES siguen parametrizados ($1, $2…).
 *
 * El dedup recibe el HASH de IP (no la IP cruda) — el route pasa hashIp(req).
 */
import { createHmac } from "crypto";
import { eq, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { env } from "@/config/env";
import { incidentOwnership } from "@/tenant/ownership";
import type { TenantScope } from "@/tenant/scope";

const { clickCounters } = schema;

const PSYCHOLOGY_HELP_KEY = "psychology_help";

/**
 * Tokens válidos para el callback del Google Forms (source:"form"):
 *  1. PSYCH_FORM_SUBMIT_SECRET, si el mantenedor lo define (override).
 *  2. Uno DERIVADO del JWT_SECRET ya configurado (HMAC con separación de
 *     dominio) — cero configuración extra: el valor lo devuelve el endpoint
 *     admin /api/public/psychology/form-callback, nunca se escribe en código.
 */
export function expectedFormTokens(): string[] {
  const tokens: string[] = [];
  if (env.PSYCH_FORM_SUBMIT_SECRET) tokens.push(env.PSYCH_FORM_SUBMIT_SECRET);
  if (env.JWT_SECRET) {
    tokens.push(
      createHmac("sha256", env.JWT_SECRET)
        .update("psych-form-submit:v1")
        .digest("hex"),
    );
  }
  return tokens;
}

export async function getPsychologyHelpClickCount(): Promise<number> {
  const db = await getDb();
  const rows = await db
    .select({ count: clickCounters.count })
    .from(clickCounters)
    .where(eq(clickCounters.key, PSYCHOLOGY_HELP_KEY));
  return Number(rows[0]?.count ?? 0);
}

/**
 * Incremento por ENVÍO de formulario (callback del Apps Script de Google,
 * autenticado por secreto compartido en el route). SIN dedup por IP: las
 * llamadas vienen de servidores de Google y cada una es un envío real.
 */
export async function incrementPsychologyHelpFromForm(scope: TenantScope): Promise<number> {
  const db = await getDb();
  await db
    .insert(clickCounters)
    .values({ key: PSYCHOLOGY_HELP_KEY, count: 0, ...incidentOwnership(scope) })
    .onConflictDoNothing({ target: clickCounters.key });
  const result = await db.execute(sql`
    UPDATE click_counters SET count = count + 1
    WHERE key = ${PSYCHOLOGY_HELP_KEY}
    RETURNING count
  `);
  const rows = (Array.isArray(result) ? result : result.rows) as {
    count: number;
  }[];
  return Number(rows[0]?.count ?? 0);
}

/** Incrementa el contador una vez por IP (hash). Devuelve el total resultante. */
export async function incrementPsychologyHelpClick(
  ipKey: string,
  scope: TenantScope,
): Promise<number> {
  const db = await getDb();
  const ownership = incidentOwnership(scope);
  // Aseguramos primero que la fila base del contador exista.
  await db
    .insert(clickCounters)
    .values({ key: PSYCHOLOGY_HELP_KEY, count: 0, ...ownership })
    .onConflictDoNothing({ target: clickCounters.key });

  // Dedup por IP + incremento + lectura del total en UNA sentencia (CTE atómico):
  //  - IP nueva → `ins` trae fila → `upd` incrementa y devuelve el nuevo total.
  //  - IP repite → `ins` vacío → `upd` no corre → caemos al total actual.
  const result = await db.execute(sql`
    WITH ins AS (
      INSERT INTO click_counter_dedup (counter_key, ip_hash, created_at, organization_id, incident_id)
      VALUES (${PSYCHOLOGY_HELP_KEY}, ${ipKey}, ${Date.now()}, ${ownership.organizationId}, ${ownership.incidentId})
      ON CONFLICT DO NOTHING
      RETURNING counter_key
    ),
    upd AS (
      UPDATE click_counters SET count = count + 1
      WHERE key = ${PSYCHOLOGY_HELP_KEY} AND EXISTS (SELECT 1 FROM ins)
      RETURNING count
    )
    SELECT COALESCE(
      (SELECT count FROM upd),
      (SELECT count FROM click_counters WHERE key = ${PSYCHOLOGY_HELP_KEY})
    ) AS count
  `);
  const rows = (Array.isArray(result) ? result : result.rows) as {
    count: number;
  }[];
  return Number(rows[0]?.count ?? 0);
}
