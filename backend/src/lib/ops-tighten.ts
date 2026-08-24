/**
 * U8 Colombia tenant tighten — pure helpers (KTD6 steps 4-6).
 *
 * The apply loop lives in `backend/worker/ops-tighten.ts` (Node + pg).
 * Do not import that worker file from the Cloudflare Worker request path.
 */
import {
  loadBackfillManifest,
  quoteIdent,
  type BackfillManifest,
  type BackfillTable,
} from "@/lib/ops-backfill";

export const TIGHTEN_CONFIRM = "colombia-u8-tighten";
export const TIGHTEN_OPERATION_ID = "u8-colombia-tighten";
export const TENANT_INDEX_SUFFIX = "_tenant_scope_idx";
export const ORG_NN_SUFFIX = "_organization_id_nn";
export const INCIDENT_NN_SUFFIX = "_incident_id_nn";
export const OWNERSHIP_FK_SUFFIX = "_incident_ownership_fk";

export type TightenMode = "count-only" | "apply";

export interface TightenArgs {
  domain: string;
  mode: TightenMode;
  confirm?: string;
  operator?: string;
  manifestPath?: string;
  replaceInvalidIndex?: boolean;
}

export function orgNnName(table: string): string {
  return `${table}${ORG_NN_SUFFIX}`;
}

export function incidentNnName(table: string): string {
  return `${table}${INCIDENT_NN_SUFFIX}`;
}

export function ownershipFkName(table: string): string {
  return `${table}${OWNERSHIP_FK_SUFFIX}`;
}

export function tenantIndexName(table: string): string {
  return `${table}${TENANT_INDEX_SUFFIX}`;
}

export function parseTightenArgs(argv: string[]): TightenArgs {
  const raw: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token?.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      raw[key] = next;
      i += 1;
    } else {
      raw[key] = "true";
    }
  }

  const domain = raw.domain;
  if (!domain) {
    throw new Error("missing --domain");
  }

  const mode = raw.mode ?? "count-only";
  if (mode !== "count-only" && mode !== "apply") {
    throw new Error(`invalid --mode ${JSON.stringify(mode)}`);
  }

  return {
    domain,
    mode,
    confirm: raw.confirm,
    operator: raw.operator,
    manifestPath: raw.manifest,
    replaceInvalidIndex: raw["replace-invalid-index"] === "true",
  };
}

export function loadTightenManifest(path: string): BackfillManifest {
  return loadBackfillManifest(path);
}

export function assertZeroUnscoped(table: string, count: number): void {
  if (count > 0) {
    throw new Error(
      `${table}: ${count} unscoped row(s) remain. Finish U8 backfill before tighten.`,
    );
  }
}

export function buildAddCheckSql(table: string, column: "organization_id" | "incident_id"): string {
  const t = quoteIdent(table);
  const col = quoteIdent(column);
  const name = column === "organization_id" ? orgNnName(table) : incidentNnName(table);
  return `ALTER TABLE ${t} ADD CONSTRAINT ${quoteIdent(name)} CHECK (${col} IS NOT NULL) NOT VALID`;
}

export function buildValidateConstraintSql(table: string, constraint: string): string {
  return `ALTER TABLE ${quoteIdent(table)} VALIDATE CONSTRAINT ${quoteIdent(constraint)}`;
}

export function buildDropConstraintSql(table: string, constraint: string): string {
  return `ALTER TABLE ${quoteIdent(table)} DROP CONSTRAINT IF EXISTS ${quoteIdent(constraint)}`;
}

export function buildSetNotNullSql(table: string, column: "organization_id" | "incident_id"): string {
  return `ALTER TABLE ${quoteIdent(table)} ALTER COLUMN ${quoteIdent(column)} SET NOT NULL`;
}

export function expectedIndexDef(table: string): string {
  return `CREATE INDEX ${tenantIndexName(table)} ON public.${table} USING btree (organization_id, incident_id)`;
}

export function buildCreateIndexConcurrentSql(table: string): string {
  return `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${quoteIdent(tenantIndexName(table))} ON ${quoteIdent(table)} (organization_id, incident_id)`;
}

export function buildCreateIndexSql(table: string): string {
  return `CREATE INDEX IF NOT EXISTS ${quoteIdent(tenantIndexName(table))} ON ${quoteIdent(table)} USING btree (organization_id, incident_id)`;
}

export function buildDropIndexConcurrentSql(table: string): string {
  return `DROP INDEX CONCURRENTLY IF EXISTS ${quoteIdent(tenantIndexName(table))}`;
}

export function normalizeIndexDef(def: string): string {
  return def
    .replace(/\s+/g, " ")
    .replace(/public\./g, "")
    .replace(/"/g, "")
    .trim()
    .toLowerCase();
}

export function indexDefinitionMatches(actual: string, table: string): boolean {
  const got = normalizeIndexDef(actual);
  const want = normalizeIndexDef(expectedIndexDef(table));
  const wantAlt = normalizeIndexDef(
    `CREATE INDEX ${tenantIndexName(table)} ON ${table} USING btree (organization_id, incident_id)`,
  );
  return got === want || got === wantAlt;
}

export function tightenTables(manifest: BackfillManifest, domain: string): BackfillTable[] {
  const tables = manifest.domains[domain]?.tables;
  if (!tables) {
    const known = Object.keys(manifest.domains).sort().join(", ");
    throw new Error(`unknown domain ${JSON.stringify(domain)}. Known: ${known}`);
  }
  return tables;
}

export function allTightenTables(manifest: BackfillManifest): BackfillTable[] {
  return Object.keys(manifest.domains)
    .sort()
    .flatMap((domain) => manifest.domains[domain]?.tables ?? []);
}
