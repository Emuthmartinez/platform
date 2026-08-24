/**
 * ============================================================================
 * Schema DRIFT detector: columns the code names vs columns the database has.
 * ============================================================================
 *
 * WHY: on 2026-08-11 a commit on `main` shipped volunteer-form code AND
 * migration 0003 (`phone` -> `contact`). Pushing to `main` deploys CODE.
 * Migrations stay human-gated. For ~6 hours the Worker inserted
 * `volunteers.contact` against a table that still had `phone`. Every public
 * volunteer registration returned 503.
 *
 * `/api/readyz` runs `SELECT 1`, which succeeds on a drifted schema, so the
 * deploy smoke stayed green.
 *
 * WHAT IT COMPARES:
 * Columns on `information_schema`, not the migration counter. The journal is
 * a secondary signal (pending tags). Campaign tables live in
 * `infra/db/schema-campaign.ts` and are included.
 *
 * WHAT IT DOES NOT DO:
 * - It writes nothing.
 * - It does not apply migrations.
 * - It does not inspect row data.
 *
 * WHERE IT RUNS:
 * - `npm run check:schema-drift` locally against DATABASE_URL (TCP `pg`,
 *   same as `migrate.ts`; not Neon HTTP).
 * - Production backend upload AND staging backend deploy, BEFORE wrangler
 *   deploy/upload. Fail closed.
 *
 * It is deliberately not wired to `/api/readyz`. A pending migration is a
 * legitimate state.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  diffMissingColumns,
  expectedFromSchema,
  type ExpectedTable,
} from "./schema-capability";
import { querySql } from "./sql-query";

const JOURNAL_PATH =
  process.env.MIGRATIONS_JOURNAL ||
  new URL("../../infra/db/migrations/meta/_journal.json", import.meta.url).pathname;

export { expectedFromSchema, diffMissingColumns };
export type { ExpectedTable };

function isExecutedDirectly(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return resolve(entry).endsWith("check-schema-drift.ts");
}

export async function runSchemaDriftCheck(databaseUrl: string): Promise<{
  ok: boolean;
  pending: string[];
  missingTables: string[];
  missingColumns: string[];
  expectedTableCount: number;
}> {
  const expected = expectedFromSchema();
  const rows = await querySql<{ table_name: string; column_name: string }>(
    databaseUrl,
    `SELECT table_name, column_name
       FROM information_schema.columns
      WHERE table_schema = 'public'`,
  );

  const actual = new Map<string, Set<string>>();
  for (const row of rows) {
    if (!actual.has(row.table_name)) actual.set(row.table_name, new Set());
    actual.get(row.table_name)!.add(row.column_name);
  }

  const { missingTables, missingColumns } = diffMissingColumns(expected, actual);

  let pending: string[] = [];
  try {
    const journal = JSON.parse(readFileSync(JOURNAL_PATH, "utf8")) as {
      entries: { idx: number; when: number; tag: string }[];
    };
    const appliedRows = await querySql<{ created_at: string | number }>(
      databaseUrl,
      "SELECT created_at FROM drizzle.__drizzle_migrations",
    );
    const appliedWhen = new Set(appliedRows.map((row) => String(row.created_at)));
    pending = journal.entries
      .filter((entry) => !appliedWhen.has(String(entry.when)))
      .map((entry) => entry.tag);
  } catch (err) {
    console.warn(
      `[drift] warning: could not read the migration journal (${
        err instanceof Error ? err.message : String(err)
      }). Column comparison remains valid.`,
    );
  }

  return {
    ok: missingTables.length === 0 && missingColumns.length === 0,
    pending,
    missingTables,
    missingColumns,
    expectedTableCount: expected.length,
  };
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set.");
  const expected = expectedFromSchema();
  console.log(
    `[drift] code schema: ${expected.length} tables, ` +
      `${expected.reduce((n, t) => n + t.columns.length, 0)} columns`,
  );

  const result = await runSchemaDriftCheck(url);
  if (result.pending.length) {
    console.error(`[drift] UNAPPLIED migrations: ${result.pending.join(", ")}`);
  }
  if (!result.ok) {
    console.error("");
    console.error("=".repeat(72));
    console.error("SCHEMA DRIFT: deployed code names objects the database does not have.");
    console.error("=".repeat(72));
    if (result.missingTables.length) {
      console.error(
        `  missing tables  (${result.missingTables.length}): ${result.missingTables.join(", ")}`,
      );
    }
    if (result.missingColumns.length) {
      console.error(`  missing columns (${result.missingColumns.length}):`);
      for (const column of result.missingColumns) console.error(`    - ${column}`);
    }
    console.error("");
    console.error("  Every endpoint that touches those columns will return 5xx.");
    console.error(
      result.pending.length
        ? `  Likely cause: apply ${result.pending.join(", ")}. Migrations are\n` +
            "  HUMAN-GATED (see CLAUDE.md): do not automate them."
        : "  No pending journal entries: the database was changed outside\n" +
            "  migrations, or the journal is incomplete.",
    );
    console.error("");
    process.exit(1);
  }

  console.log(
    result.pending.length
      ? "[drift] no column drift, but migrations are pending (see above)."
      : "[drift] OK: the database has every table and column the code expects.",
  );
}

if (isExecutedDirectly()) {
  main().catch((err) => {
    console.error("[drift] fatal:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
