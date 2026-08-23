/**
 * ============================================================================
 * Detector de DERIVA de esquema: lo que el codigo espera vs lo que la base tiene.
 * ============================================================================
 *
 * POR QUE EXISTE: el 2026-08-11 un commit subio a `main` el codigo del formulario
 * ramificado de voluntarios Y su migracion 0003 (`phone` -> `contact` + 8
 * columnas). Pushear a `main` despliega CODIGO; las migraciones van gateadas por
 * un humano y no las corre nadie automaticamente. Resultado: durante ~6h el
 * Worker inserto en `volunteers.contact` contra una tabla que seguia teniendo
 * `phone`. TODOS los registros publicos de voluntarios fallaron con 503 y ~44
 * personas afectadas por el terremoto perdieron su inscripcion.
 *
 * Nada en el pipeline podia verlo: `/api/readyz` hace `SELECT 1`, que pasa
 * perfectamente con el esquema derivado, asi que el smoke check del deploy dio
 * VERDE durante toda la caida.
 *
 * QUE COMPARA (y por que asi):
 *
 * Compara COLUMNAS, no el contador de migraciones. Contar filas de
 * `__drizzle_migrations` es un proxy debil: no ve un ALTER hecho a mano, no ve
 * una migracion aplicada a medias, y empata en cuanto los numeros coinciden por
 * casualidad. La pregunta que de verdad importa es "¿existe cada columna que el
 * codigo va a nombrar?", y esa se responde contra `information_schema`.
 *
 * El journal se compara igual, pero como SEÑAL SECUNDARIA: dice *por que* hay
 * deriva (migracion pendiente) cuando la hay.
 *
 * QUE NO HACE:
 *  - No escribe NADA. Solo lee `information_schema` y `drizzle.__drizzle_migrations`.
 *  - No aplica migraciones. El gate humano de CLAUDE.md sigue intacto.
 *  - No mira datos, solo nombres de tablas y columnas — no hay PII posible aqui.
 *
 * DONDE CORRE:
 *  - `npm run check:schema-drift` en local, contra lo que apunte DATABASE_URL.
 *  - En el deploy de backend, DESPUES de desplegar, contra produccion: si hay
 *    deriva el job se pone rojo de inmediato en vez de tardar 6h en notarse.
 *  - En un cron, como red de seguridad que no depende de que nadie se acuerde.
 *
 * Deliberadamente NO se cuelga de `/api/readyz`: una migracion pendiente es un
 * estado LEGITIMO (el gate humano existe justo para que pueda esperar), y marcar
 * toda la API como no-lista por eso convertiria un fallo acotado a las escrituras
 * de una tabla en una caida total. Ver el veredicto del council en
 * docs/plans/ y AGENTS.md -> "Migraciones".
 */
import { neon } from "@neondatabase/serverless";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import { is } from "drizzle-orm";
import { readFileSync } from "node:fs";
import * as schema from "../../infra/db/schema.js";
import * as campaignSchema from "../../infra/db/schema-campaign.js";

const JOURNAL_PATH =
  process.env.MIGRATIONS_JOURNAL ||
  new URL("../../infra/db/migrations/meta/_journal.json", import.meta.url).pathname;

interface Expected {
  table: string;
  columns: string[];
}

/** Lo que el CODIGO espera: `schema.ts` plus `schema-campaign.ts`. */
function expectedFromSchema(): Expected[] {
  const out: Expected[] = [];
  for (const value of Object.values({ ...schema, ...campaignSchema })) {
    if (!is(value, PgTable)) continue;
    const cfg = getTableConfig(value as PgTable);
    out.push({
      table: cfg.name,
      columns: cfg.columns.map((c) => c.name).sort(),
    });
  }
  return out.sort((a, b) => a.table.localeCompare(b.table));
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL no configurada.");
  const sql = neon(url);

  const expected = expectedFromSchema();
  console.log(
    `[drift] esquema del codigo: ${expected.length} tablas, ` +
      `${expected.reduce((n, t) => n + t.columns.length, 0)} columnas`,
  );

  // Estado real. Una sola consulta para todo el esquema public.
  const rows = (await sql.query(
    `SELECT table_name, column_name
       FROM information_schema.columns
      WHERE table_schema = 'public'`,
  )) as { table_name: string; column_name: string }[];

  const actual = new Map<string, Set<string>>();
  for (const r of rows) {
    if (!actual.has(r.table_name)) actual.set(r.table_name, new Set());
    actual.get(r.table_name)!.add(r.column_name);
  }

  const missingTables: string[] = [];
  const missingColumns: string[] = [];

  for (const t of expected) {
    const have = actual.get(t.table);
    if (!have) {
      missingTables.push(t.table);
      continue;
    }
    for (const col of t.columns) {
      // El caso exacto del incidente: el codigo nombra `contact`, la base tiene
      // `phone`. Aparece aqui como columna que falta.
      if (!have.has(col)) missingColumns.push(`${t.table}.${col}`);
    }
  }

  // Señal secundaria: ¿hay migraciones en el repo sin aplicar? Explica el POR QUE
  // de la deriva. No es la comprobacion principal — ver el encabezado.
  let pending: string[] = [];
  try {
    const journal = JSON.parse(readFileSync(JOURNAL_PATH, "utf8")) as {
      entries: { idx: number; when: number; tag: string }[];
    };
    const appliedRows = (await sql.query(
      "SELECT created_at FROM drizzle.__drizzle_migrations",
    )) as { created_at: string | number }[];
    // drizzle guarda en `created_at` el `when` del journal, no la hora de
    // aplicacion. Se comparan como numeros.
    const appliedWhen = new Set(appliedRows.map((r) => String(r.created_at)));
    pending = journal.entries
      .filter((e) => !appliedWhen.has(String(e.when)))
      .map((e) => e.tag);
  } catch (err) {
    console.warn(
      `[drift] aviso: no se pudo leer el journal de migraciones (${
        err instanceof Error ? err.message : String(err)
      }). La comprobacion de columnas sigue siendo valida.`,
    );
  }

  if (pending.length) {
    console.error(`[drift] migraciones SIN APLICAR: ${pending.join(", ")}`);
  }

  if (missingTables.length || missingColumns.length) {
    console.error("");
    console.error("=".repeat(72));
    console.error("DERIVA DE ESQUEMA: el codigo desplegado espera algo que la base NO tiene.");
    console.error("=".repeat(72));
    if (missingTables.length) {
      console.error(`  tablas que faltan  (${missingTables.length}): ${missingTables.join(", ")}`);
    }
    if (missingColumns.length) {
      console.error(`  columnas que faltan (${missingColumns.length}):`);
      for (const c of missingColumns) console.error(`    - ${c}`);
    }
    console.error("");
    console.error("  Todo endpoint que toque esas columnas devolvera 5xx.");
    console.error(
      pending.length
        ? `  Causa probable: falta aplicar ${pending.join(", ")}. Aplicar migraciones\n` +
            "  es una accion GATEADA POR UN HUMANO (ver CLAUDE.md): no la automatices."
        : "  No hay migraciones pendientes en el journal: la base fue modificada\n" +
            "  fuera de las migraciones, o el journal esta incompleto.",
    );
    console.error("");
    process.exit(1);
  }

  console.log(
    pending.length
      ? "[drift] sin deriva de columnas, pero hay migraciones pendientes (arriba)."
      : "[drift] OK: la base tiene todas las tablas y columnas que el codigo espera.",
  );
}

main().catch((err) => {
  console.error("[drift] fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
