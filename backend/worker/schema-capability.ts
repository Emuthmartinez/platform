/**
 * Schema objects the running code will name. Used by the column-drift gate
 * and the U0 platform-schema verifier. Does not open a database connection.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import * as coreSchema from "../../infra/db/schema.js";
import * as campaignSchema from "../../infra/db/schema-campaign.js";

export interface ExpectedTable {
  table: string;
  columns: string[];
}

export function expectedFromSchemaModules(
  modules: Record<string, unknown>[],
): ExpectedTable[] {
  const out: ExpectedTable[] = [];
  for (const schema of modules) {
    for (const value of Object.values(schema)) {
      if (!is(value, PgTable)) continue;
      const cfg = getTableConfig(value as PgTable);
      out.push({
        table: cfg.name,
        columns: cfg.columns.map((column) => column.name).sort(),
      });
    }
  }
  return out.sort((a, b) => a.table.localeCompare(b.table));
}

/** Core operational schema plus reconstruction-campaign tables. */
export function expectedFromSchema(): ExpectedTable[] {
  return expectedFromSchemaModules([coreSchema, campaignSchema]);
}

export function journalSha256(journalPath: string): string {
  const bytes = readFileSync(journalPath);
  return createHash("sha256").update(bytes).digest("hex");
}

export function diffMissingColumns(
  expected: ExpectedTable[],
  actual: Map<string, Set<string>>,
): { missingTables: string[]; missingColumns: string[] } {
  const missingTables: string[] = [];
  const missingColumns: string[] = [];
  for (const table of expected) {
    const have = actual.get(table.table);
    if (!have) {
      missingTables.push(table.table);
      continue;
    }
    for (const column of table.columns) {
      if (!have.has(column)) missingColumns.push(`${table.table}.${column}`);
    }
  }
  return { missingTables, missingColumns };
}
