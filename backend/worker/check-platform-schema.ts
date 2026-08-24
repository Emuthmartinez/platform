/**
 * U0 schema capability verifier.
 *
 * Column drift (including campaign tables) plus journal SHA256, plus U8
 * tenant tighten: NOT NULL, validated composite FKs, valid tenant-leading
 * indexes. Fail closed. Do not report pass before these exist.
 */
import { resolve } from "node:path";
import { journalSha256 } from "./schema-capability";
import { expectedFromSchema, runSchemaDriftCheck } from "./check-schema-drift";
import { loadBackfillManifest } from "../src/lib/ops-backfill";
import { allTightenTables, tenantIndexName, ownershipFkName } from "../src/lib/ops-tighten";
import { querySql } from "./sql-query";

const JOURNAL_PATH =
  process.env.MIGRATIONS_JOURNAL ||
  new URL("../../infra/db/migrations/meta/_journal.json", import.meta.url).pathname;

const MANIFEST_PATH =
  process.env.U8_BACKFILL_MANIFEST ||
  new URL("../../infra/db/operations/u8-colombia-backfill.manifest.json", import.meta.url)
    .pathname;

function isExecutedDirectly(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return resolve(entry).endsWith("check-platform-schema.ts");
}

function tightenTableNames(): string[] {
  return allTightenTables(loadBackfillManifest(MANIFEST_PATH)).map((t) => t.name);
}

export async function checkTenantTightenState(
  databaseUrl: string,
): Promise<string[]> {
  const tables = tightenTableNames();
  const rows = await querySql<{
    table_name: string;
    org_not_null: boolean;
    incident_not_null: boolean;
    fk_validated: boolean;
    index_valid: boolean;
  }>(
    databaseUrl,
    `SELECT c.relname AS table_name,
            bool_or(a.attname = 'organization_id' AND a.attnotnull) AS org_not_null,
            bool_or(a.attname = 'incident_id' AND a.attnotnull) AS incident_not_null,
            COALESCE(bool_or(con.conname = c.relname || '_incident_ownership_fk' AND con.convalidated), false) AS fk_validated,
            COALESCE(bool_or(idx.relname = c.relname || '_tenant_scope_idx' AND i.indisvalid), false) AS index_valid
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
       LEFT JOIN pg_constraint con
         ON con.conrelid = c.oid AND con.conname = c.relname || '_incident_ownership_fk'
       LEFT JOIN pg_index i
         ON i.indrelid = c.oid
       LEFT JOIN pg_class idx
         ON idx.oid = i.indexrelid AND idx.relname = c.relname || '_tenant_scope_idx'
      WHERE n.nspname = 'public'
        AND c.relname = ANY($1::text[])
        AND a.attname IN ('organization_id', 'incident_id')
      GROUP BY c.relname
      ORDER BY c.relname`,
    [tables],
  );

  const seen = new Set(rows.map((r) => r.table_name));
  const problems: string[] = [];
  for (const name of tables) {
    if (!seen.has(name)) {
      problems.push(`${name}: missing from database`);
      continue;
    }
  }
  for (const row of rows) {
    if (!row.org_not_null) problems.push(`${row.table_name}: organization_id is nullable`);
    if (!row.incident_not_null) {
      problems.push(`${row.table_name}: incident_id is nullable`);
    }
    if (!row.fk_validated) {
      problems.push(
        `${row.table_name}: ${ownershipFkName(row.table_name)} is missing or not validated`,
      );
    }
    if (!row.index_valid) {
      problems.push(
        `${row.table_name}: ${tenantIndexName(row.table_name)} is missing or indisvalid=false`,
      );
    }
  }
  return problems;
}

export async function runPlatformSchemaCheck(databaseUrl: string): Promise<void> {
  const expected = expectedFromSchema();
  const digest = journalSha256(JOURNAL_PATH);
  console.log(
    `[platform-schema] capability=column-drift+journal+u8-tighten tables=${expected.length}`,
  );
  console.log(`[platform-schema] journal sha256: ${digest}`);
  const expectedJournal = process.env.EXPECTED_JOURNAL_SHA?.trim();
  if (expectedJournal && expectedJournal !== digest) {
    console.error(
      `[platform-schema] journal SHA mismatch: expected ${expectedJournal}`,
    );
    process.exit(1);
  }

  const result = await runSchemaDriftCheck(databaseUrl);
  if (result.pending.length) {
    console.error(
      `[platform-schema] UNAPPLIED migrations: ${result.pending.join(", ")}`,
    );
  }
  if (!result.ok) {
    console.error("[platform-schema] column drift failed (see check-schema-drift).");
    if (result.missingTables.length) {
      console.error(`  missing tables: ${result.missingTables.join(", ")}`);
    }
    for (const column of result.missingColumns) {
      console.error(`  missing column: ${column}`);
    }
    process.exit(1);
  }

  const tightenProblems = await checkTenantTightenState(databaseUrl);
  if (tightenProblems.length) {
    console.error("[platform-schema] U8 tenant tighten failed:");
    for (const problem of tightenProblems) {
      console.error(`  ${problem}`);
    }
    process.exit(1);
  }

  console.log("[platform-schema] U8 tighten: NOT NULL + validated FKs + tenant indexes OK");
  console.log("[platform-schema] OK");
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set.");
  await runPlatformSchemaCheck(url);
}

if (isExecutedDirectly()) {
  main().catch((err) => {
    console.error("[platform-schema] fatal:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
