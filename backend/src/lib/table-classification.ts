import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import * as schema from "../../../infra/db/schema.js";
import * as campaignSchema from "../../../infra/db/schema-campaign.js";

export const CLASSIFICATION_SCOPES = [
  "global",
  "organization",
  "incident",
  "mixed",
] as const;

export type ClassificationScope = (typeof CLASSIFICATION_SCOPES)[number];

export interface ClassificationEntry {
  name: string;
  scope: ClassificationScope;
  reason: string;
}

export interface ClassificationFile {
  version: number;
  ktd: string;
  tables: ClassificationEntry[];
}

const HERE = dirname(fileURLToPath(import.meta.url));

export const CLASSIFICATION_PATH =
  process.env.TABLE_CLASSIFICATION_PATH ||
  join(HERE, "../../../docs/platform/table-classification.json");

export function drizzleTableNames(): string[] {
  const names: string[] = [];
  for (const value of Object.values({ ...schema, ...campaignSchema })) {
    if (!is(value, PgTable)) continue;
    names.push(getTableConfig(value).name);
  }
  return [...new Set(names)].sort();
}

export function loadClassification(
  path = CLASSIFICATION_PATH,
): ClassificationFile {
  return JSON.parse(readFileSync(path, "utf8")) as ClassificationFile;
}

export function classificationProblems(
  file: ClassificationFile,
  drizzleNames: string[],
): string[] {
  const problems: string[] = [];
  if (!Array.isArray(file.tables)) {
    return ["classification file has no tables array"];
  }

  const seen = new Set<string>();
  for (const entry of file.tables) {
    if (!entry.name) {
      problems.push("classification entry is missing name");
      continue;
    }
    if (seen.has(entry.name)) {
      problems.push(`duplicate classification entry: ${entry.name}`);
    }
    seen.add(entry.name);
    if (
      !CLASSIFICATION_SCOPES.includes(entry.scope as ClassificationScope)
    ) {
      problems.push(
        `${entry.name}: invalid scope ${JSON.stringify(entry.scope)}`,
      );
    }
    if (!entry.reason || !entry.reason.trim()) {
      problems.push(`${entry.name}: missing reason`);
    }
  }

  for (const name of drizzleNames) {
    if (!seen.has(name)) {
      problems.push(`Drizzle table has no classification: ${name}`);
    }
  }
  for (const name of seen) {
    if (!drizzleNames.includes(name)) {
      problems.push(`classification names a table Drizzle does not export: ${name}`);
    }
  }
  return problems;
}
