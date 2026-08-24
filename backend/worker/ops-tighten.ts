/**
 * U8 operational tighten runner (KTD6 steps 4 and 6).
 *
 * Adds/validates temporary NOT NULL checks, validates composite FKs, and
 * creates tenant-leading indexes CONCURRENTLY. SET NOT NULL lives in
 * `0024_tenant_tighten.sql` and is applied by `migrate.ts`.
 *
 * Does not call `seedAuth()`. Do not import this file from the Worker
 * request path.
 *
 *   npm run ops:tighten -- --domain reports --mode count-only
 *   npm run ops:tighten -- --domain reports --mode apply
 */
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool, type PoolClient } from "pg";
import {
  assertSafeDatabaseUrl,
  buildUnscopedCountSql,
  manifestChecksum,
} from "@/lib/ops-backfill";
import {
  TIGHTEN_CONFIRM,
  TIGHTEN_OPERATION_ID,
  assertZeroUnscoped,
  buildAddCheckSql,
  buildCreateIndexConcurrentSql,
  buildDropIndexConcurrentSql,
  buildValidateConstraintSql,
  incidentNnName,
  indexDefinitionMatches,
  loadTightenManifest,
  orgNnName,
  ownershipFkName,
  parseTightenArgs,
  tenantIndexName,
  tightenTables,
  type TightenArgs,
  type TightenMode,
} from "@/lib/ops-tighten";
import type { BackfillManifest, BackfillTable } from "@/lib/ops-backfill";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_MANIFEST = join(
  HERE,
  "../../infra/db/operations/u8-colombia-backfill.manifest.json",
);

const PROGRESS_DDL = `
CREATE TABLE IF NOT EXISTS ops_tighten_progress (
  operation_id text NOT NULL,
  domain text NOT NULL,
  table_name text NOT NULL,
  org_attnotnull boolean NOT NULL DEFAULT false,
  incident_attnotnull boolean NOT NULL DEFAULT false,
  fk_validated boolean NOT NULL DEFAULT false,
  index_valid boolean NOT NULL DEFAULT false,
  manifest_checksum text NOT NULL,
  status text NOT NULL,
  operator text,
  updated_at bigint NOT NULL,
  PRIMARY KEY (operation_id, domain, table_name)
)
`;

export interface TableTightenResult {
  table: string;
  unscoped: number;
  orgNotNull: boolean;
  incidentNotNull: boolean;
  fkValidated: boolean;
  indexValid: boolean;
  status: "count-only" | "complete";
}

export interface DomainTightenResult {
  domain: string;
  mode: TightenMode;
  manifestChecksum: string;
  operator: string;
  tables: TableTightenResult[];
}

export interface RunTightenOptions {
  databaseUrl: string;
  args: TightenArgs;
  nodeEnv?: string;
  manifest?: BackfillManifest;
  manifestPath?: string;
}

interface ColumnNullability {
  orgNotNull: boolean;
  incidentNotNull: boolean;
}

async function countUnscoped(client: PoolClient, table: string): Promise<number> {
  const result = await client.query<{ n: string }>(buildUnscopedCountSql(table));
  return Number(result.rows[0]?.n ?? 0);
}

async function readNullability(
  client: PoolClient,
  table: string,
): Promise<ColumnNullability> {
  const result = await client.query<{ column_name: string; attnotnull: boolean }>(
    `SELECT a.attname AS column_name, a.attnotnull
       FROM pg_attribute a
       JOIN pg_class c ON c.oid = a.attrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relname = $1
        AND a.attname IN ('organization_id', 'incident_id')
        AND a.attnum > 0
        AND NOT a.attisdropped`,
    [table],
  );
  const org = result.rows.find((r) => r.column_name === "organization_id");
  const incident = result.rows.find((r) => r.column_name === "incident_id");
  if (!org || !incident) {
    throw new Error(`${table}: missing organization_id or incident_id`);
  }
  return { orgNotNull: org.attnotnull, incidentNotNull: incident.attnotnull };
}

async function constraintExists(
  client: PoolClient,
  table: string,
  name: string,
): Promise<{ exists: boolean; validated: boolean }> {
  const result = await client.query<{ convalidated: boolean }>(
    `SELECT convalidated
       FROM pg_constraint
      WHERE conname = $1
        AND conrelid = $2::regclass`,
    [name, `public.${table}`],
  );
  const row = result.rows[0];
  if (!row) return { exists: false, validated: false };
  return { exists: true, validated: row.convalidated };
}

async function ensureCheck(
  client: PoolClient,
  table: string,
  column: "organization_id" | "incident_id",
  alreadyNotNull: boolean,
): Promise<void> {
  if (alreadyNotNull) return;
  const name =
    column === "organization_id" ? orgNnName(table) : incidentNnName(table);
  const state = await constraintExists(client, table, name);
  if (!state.exists) {
    await client.query(buildAddCheckSql(table, column));
  }
  const after = await constraintExists(client, table, name);
  if (!after.validated) {
    await client.query(buildValidateConstraintSql(table, name));
  }
}

async function ensureFkValidated(client: PoolClient, table: string): Promise<boolean> {
  const name = ownershipFkName(table);
  const state = await constraintExists(client, table, name);
  if (!state.exists) {
    throw new Error(`${table}: missing ${name}`);
  }
  if (!state.validated) {
    await client.query(buildValidateConstraintSql(table, name));
  }
  return true;
}

interface IndexState {
  exists: boolean;
  valid: boolean;
  def: string | null;
}

async function readIndex(client: PoolClient, table: string): Promise<IndexState> {
  const name = tenantIndexName(table);
  const result = await client.query<{ indisvalid: boolean; indexdef: string }>(
    `SELECT i.indisvalid, pg_get_indexdef(i.indexrelid) AS indexdef
       FROM pg_index i
       JOIN pg_class idx ON idx.oid = i.indexrelid
       JOIN pg_class tbl ON tbl.oid = i.indrelid
       JOIN pg_namespace n ON n.oid = tbl.relnamespace
      WHERE n.nspname = 'public'
        AND tbl.relname = $1
        AND idx.relname = $2`,
    [table, name],
  );
  const row = result.rows[0];
  if (!row) return { exists: false, valid: false, def: null };
  return { exists: true, valid: row.indisvalid, def: row.indexdef };
}

async function ensureIndex(
  client: PoolClient,
  table: string,
  replaceInvalid: boolean,
): Promise<boolean> {
  const state = await readIndex(client, table);
  if (state.exists) {
    if (!state.valid) {
      if (!replaceInvalid) {
        throw new Error(
          `${table}: index ${tenantIndexName(table)} exists but indisvalid=false. Re-run with --replace-invalid-index.`,
        );
      }
      await client.query("SET lock_timeout = 0");
      try {
        await client.query(buildDropIndexConcurrentSql(table));
      } finally {
        const lockMs = Number(process.env.OPS_LOCK_TIMEOUT_MS) || 15_000;
        await client.query(`SET lock_timeout = ${lockMs}`);
      }
    } else if (state.def && !indexDefinitionMatches(state.def, table)) {
      throw new Error(
        `${table}: index ${tenantIndexName(table)} definition does not match (organization_id, incident_id).`,
      );
    } else {
      return true;
    }
  }
  await client.query("SET lock_timeout = 0");
  try {
    await client.query(buildCreateIndexConcurrentSql(table));
  } finally {
    const lockMs = Number(process.env.OPS_LOCK_TIMEOUT_MS) || 15_000;
    await client.query(`SET lock_timeout = ${lockMs}`);
  }
  const after = await readIndex(client, table);
  if (!after.exists || !after.valid || !after.def) {
    throw new Error(`${table}: index ${tenantIndexName(table)} missing or invalid after create`);
  }
  if (!indexDefinitionMatches(after.def, table)) {
    throw new Error(
      `${table}: created index definition does not match (organization_id, incident_id)`,
    );
  }
  return true;
}

async function upsertProgress(
  client: PoolClient,
  input: {
    domain: string;
    table: string;
    orgNotNull: boolean;
    incidentNotNull: boolean;
    fkValidated: boolean;
    indexValid: boolean;
    checksum: string;
    status: string;
    operator: string;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO ops_tighten_progress (
       operation_id, domain, table_name, org_attnotnull, incident_attnotnull,
       fk_validated, index_valid, manifest_checksum, status, operator, updated_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT (operation_id, domain, table_name)
     DO UPDATE SET
       org_attnotnull = EXCLUDED.org_attnotnull,
       incident_attnotnull = EXCLUDED.incident_attnotnull,
       fk_validated = EXCLUDED.fk_validated,
       index_valid = EXCLUDED.index_valid,
       manifest_checksum = EXCLUDED.manifest_checksum,
       status = EXCLUDED.status,
       operator = EXCLUDED.operator,
       updated_at = EXCLUDED.updated_at`,
    [
      TIGHTEN_OPERATION_ID,
      input.domain,
      input.table,
      input.orgNotNull,
      input.incidentNotNull,
      input.fkValidated,
      input.indexValid,
      input.checksum,
      input.status,
      input.operator,
      Date.now(),
    ],
  );
}

async function tightenTable(
  client: PoolClient,
  input: {
    domainName: string;
    table: BackfillTable;
    mode: TightenMode;
    operator: string;
    checksum: string;
    replaceInvalidIndex: boolean;
  },
): Promise<TableTightenResult> {
  const unscoped = await countUnscoped(client, input.table.name);
  assertZeroUnscoped(input.table.name, unscoped);
  const nullability = await readNullability(client, input.table.name);

  switch (input.mode) {
    case "count-only":
      return {
        table: input.table.name,
        unscoped,
        orgNotNull: nullability.orgNotNull,
        incidentNotNull: nullability.incidentNotNull,
        fkValidated: false,
        indexValid: false,
        status: "count-only",
      };
    case "apply":
      break;
    default: {
      const _exhaustive: never = input.mode;
      throw new Error(`unexpected mode ${String(_exhaustive)}`);
    }
  }

  await ensureCheck(
    client,
    input.table.name,
    "organization_id",
    nullability.orgNotNull,
  );
  await ensureCheck(
    client,
    input.table.name,
    "incident_id",
    nullability.incidentNotNull,
  );
  const fkValidated = await ensureFkValidated(client, input.table.name);
  const indexValid = await ensureIndex(
    client,
    input.table.name,
    input.replaceInvalidIndex,
  );
  const after = await readNullability(client, input.table.name);
  await upsertProgress(client, {
    domain: input.domainName,
    table: input.table.name,
    orgNotNull: after.orgNotNull,
    incidentNotNull: after.incidentNotNull,
    fkValidated,
    indexValid,
    checksum: input.checksum,
    status: "complete",
    operator: input.operator,
  });
  return {
    table: input.table.name,
    unscoped,
    orgNotNull: after.orgNotNull,
    incidentNotNull: after.incidentNotNull,
    fkValidated,
    indexValid,
    status: "complete",
  };
}

export async function runDomainTighten(
  options: RunTightenOptions,
): Promise<DomainTightenResult> {
  assertSafeDatabaseUrl(options.databaseUrl, {
    confirm: options.args.confirm,
    nodeEnv: options.nodeEnv ?? process.env.NODE_ENV,
    expectedConfirm: TIGHTEN_CONFIRM,
  });

  const manifest =
    options.manifest ??
    loadTightenManifest(options.manifestPath ?? DEFAULT_MANIFEST);
  const tables = tightenTables(manifest, options.args.domain);
  const checksum = manifestChecksum(manifest);
  const operator = options.args.operator ?? process.env.OPS_OPERATOR ?? "unknown";
  const mode = options.args.mode;

  const pool = new Pool({
    connectionString: options.databaseUrl,
    max: 1,
    lock_timeout: Number(process.env.OPS_LOCK_TIMEOUT_MS) || 15_000,
    statement_timeout: Number(process.env.OPS_STATEMENT_TIMEOUT_MS) || 600_000,
  });

  const client = await pool.connect();
  try {
    if (mode === "apply") {
      await client.query(PROGRESS_DDL);
    }

    const results: TableTightenResult[] = [];
    for (const table of tables) {
      results.push(
        await tightenTable(client, {
          domainName: options.args.domain,
          table,
          mode,
          operator,
          checksum,
          replaceInvalidIndex: options.args.replaceInvalidIndex === true,
        }),
      );
    }

    return {
      domain: options.args.domain,
      mode,
      manifestChecksum: checksum,
      operator,
      tables: results,
    };
  } finally {
    client.release();
    await pool.end();
  }
}

function isExecutedDirectly(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  const resolved = resolve(entry);
  return (
    resolved.endsWith("ops-tighten.ts") || resolved.endsWith("ops-tighten.js")
  );
}

async function main(): Promise<void> {
  const args = parseTightenArgs(process.argv.slice(2));
  const databaseUrl = process.env.DATABASE_URL ?? "";
  const result = await runDomainTighten({
    databaseUrl,
    args,
    nodeEnv: process.env.NODE_ENV,
    manifestPath: args.manifestPath,
  });
  console.log(JSON.stringify(result, null, 2));
}

if (isExecutedDirectly()) {
  main().catch((err: unknown) => {
    console.error("[ops-tighten] fatal:", err);
    process.exit(1);
  });
}
