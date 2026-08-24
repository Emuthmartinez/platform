/**
 * U8 operational backfill runner (KTD6 step 3).
 *
 * Bounded committed batches on node-postgres. Not `migrate.ts`. Does not
 * call `seedAuth()`. Do not import this file from the Worker request path.
 *
 *   npm run ops:backfill -- --domain reports --mode count-only
 *   npm run ops:backfill -- --domain reports --mode apply
 */
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool, type PoolClient } from "pg";
import {
  assertSafeDatabaseUrl,
  buildBatchUpdateSql,
  buildUnscopedCountSql,
  checksumBatchRows,
  cursorFromRow,
  loadBackfillManifest,
  manifestChecksum,
  parseBackfillArgs,
  requireDomain,
  type BackfillArgs,
  type BackfillManifest,
  type BackfillMode,
  type BackfillTable,
} from "@/lib/ops-backfill";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_MANIFEST = join(
  HERE,
  "../../infra/db/operations/u8-colombia-backfill.manifest.json",
);

const PROGRESS_DDL = `
CREATE TABLE IF NOT EXISTS ops_backfill_progress (
  operation_id text NOT NULL,
  domain text NOT NULL,
  table_name text NOT NULL,
  cursor_json text,
  rows_updated bigint NOT NULL DEFAULT 0,
  batches_committed integer NOT NULL DEFAULT 0,
  last_batch_txid text,
  last_batch_checksum text,
  manifest_checksum text NOT NULL,
  status text NOT NULL,
  operator text,
  updated_at bigint NOT NULL,
  PRIMARY KEY (operation_id, domain, table_name)
)
`;

export interface TableBackfillResult {
  table: string;
  unscopedBefore: number;
  unscopedAfter: number;
  rowsUpdated: number;
  batchesCommitted: number;
  txids: string[];
  lastChecksum: string | null;
  status: "count-only" | "complete" | "interrupted";
}

export interface DomainBackfillResult {
  domain: string;
  mode: BackfillMode;
  manifestChecksum: string;
  operator: string;
  tables: TableBackfillResult[];
}

export interface RunBackfillOptions {
  databaseUrl: string;
  args: BackfillArgs;
  nodeEnv?: string;
  manifest?: BackfillManifest;
  manifestPath?: string;
}

async function countUnscoped(
  client: PoolClient,
  table: string,
): Promise<number> {
  const result = await client.query<{ n: string }>(buildUnscopedCountSql(table));
  return Number(result.rows[0]?.n ?? 0);
}

async function readProgressChecksum(
  client: PoolClient,
  operationId: string,
  domain: string,
  table: string,
): Promise<string | null> {
  const result = await client.query<{ manifest_checksum: string }>(
    `SELECT manifest_checksum
       FROM ops_backfill_progress
      WHERE operation_id = $1 AND domain = $2 AND table_name = $3`,
    [operationId, domain, table],
  );
  return result.rows[0]?.manifest_checksum ?? null;
}

async function upsertProgress(
  client: PoolClient,
  input: {
    operationId: string;
    domain: string;
    table: string;
    cursorJson: string | null;
    rowsUpdated: number;
    batchesCommitted: number;
    lastBatchTxid: string | null;
    lastBatchChecksum: string | null;
    manifestChecksum: string;
    status: string;
    operator: string;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO ops_backfill_progress (
       operation_id, domain, table_name, cursor_json, rows_updated,
       batches_committed, last_batch_txid, last_batch_checksum,
       manifest_checksum, status, operator, updated_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     ON CONFLICT (operation_id, domain, table_name)
     DO UPDATE SET
       cursor_json = EXCLUDED.cursor_json,
       rows_updated = EXCLUDED.rows_updated,
       batches_committed = EXCLUDED.batches_committed,
       last_batch_txid = EXCLUDED.last_batch_txid,
       last_batch_checksum = EXCLUDED.last_batch_checksum,
       manifest_checksum = EXCLUDED.manifest_checksum,
       status = EXCLUDED.status,
       operator = EXCLUDED.operator,
       updated_at = EXCLUDED.updated_at`,
    [
      input.operationId,
      input.domain,
      input.table,
      input.cursorJson,
      input.rowsUpdated,
      input.batchesCommitted,
      input.lastBatchTxid,
      input.lastBatchChecksum,
      input.manifestChecksum,
      input.status,
      input.operator,
      Date.now(),
    ],
  );
}

async function applyOneBatch(
  client: PoolClient,
  table: BackfillTable,
  organizationId: string,
  incidentId: string,
  batchSize: number,
): Promise<{ rows: Record<string, unknown>[]; txid: string }> {
  await client.query("BEGIN");
  try {
    const txidRes = await client.query<{ txid: string }>(
      "SELECT txid_current()::text AS txid",
    );
    const txid = txidRes.rows[0]?.txid;
    if (!txid) {
      throw new Error("txid_current() returned no row");
    }
    let updated;
    try {
      updated = await client.query<Record<string, unknown>>(
        buildBatchUpdateSql(table.name, table.pk),
        [organizationId, incidentId, batchSize],
      );
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(`${table.name}: batch update failed: ${detail}`, {
        cause: err,
      });
    }
    await client.query("COMMIT");
    return { rows: updated.rows, txid };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  }
}

async function backfillTable(
  client: PoolClient,
  input: {
    manifest: BackfillManifest;
    domainName: string;
    table: BackfillTable;
    mode: BackfillMode;
    batchSize: number;
    maxBatches: number;
    operator: string;
    checksum: string;
  },
): Promise<TableBackfillResult> {
  const unscopedBefore = await countUnscoped(client, input.table.name);
  switch (input.mode) {
    case "count-only":
      return {
        table: input.table.name,
        unscopedBefore,
        unscopedAfter: unscopedBefore,
        rowsUpdated: 0,
        batchesCommitted: 0,
        txids: [],
        lastChecksum: null,
        status: "count-only",
      };
    case "apply":
      break;
    default: {
      const _exhaustive: never = input.mode;
      throw new Error(`unexpected mode ${String(_exhaustive)}`);
    }
  }

  const existing = await readProgressChecksum(
    client,
    input.manifest.operationId,
    input.domainName,
    input.table.name,
  );
  if (existing && existing !== input.checksum) {
    throw new Error(
      `${input.table.name}: stored manifest checksum does not match this runner`,
    );
  }

  let rowsUpdated = 0;
  let batchesCommitted = 0;
  const txids: string[] = [];
  let lastChecksum: string | null = null;
  let lastCursor: string | null = null;

  while (batchesCommitted < input.maxBatches) {
    const batch = await applyOneBatch(
      client,
      input.table,
      input.manifest.organizationId,
      input.manifest.incidentId,
      input.batchSize,
    );
    if (batch.rows.length === 0) {
      break;
    }
    const lastRow = batch.rows[batch.rows.length - 1];
    if (!lastRow) {
      throw new Error(`${input.table.name}: batch returned rows without a last row`);
    }
    lastChecksum = checksumBatchRows(batch.rows, input.table.pk);
    lastCursor = cursorFromRow(lastRow, input.table.pk);
    txids.push(batch.txid);
    rowsUpdated += batch.rows.length;
    batchesCommitted += 1;
    await upsertProgress(client, {
      operationId: input.manifest.operationId,
      domain: input.domainName,
      table: input.table.name,
      cursorJson: lastCursor,
      rowsUpdated,
      batchesCommitted,
      lastBatchTxid: batch.txid,
      lastBatchChecksum: lastChecksum,
      manifestChecksum: input.checksum,
      status: "running",
      operator: input.operator,
    });
    if (batch.rows.length < input.batchSize) {
      break;
    }
  }

  const unscopedAfter = await countUnscoped(client, input.table.name);
  const status: "complete" | "interrupted" =
    unscopedAfter === 0 ? "complete" : "interrupted";

  await upsertProgress(client, {
    operationId: input.manifest.operationId,
    domain: input.domainName,
    table: input.table.name,
    cursorJson: lastCursor,
    rowsUpdated,
    batchesCommitted,
    lastBatchTxid: txids[txids.length - 1] ?? null,
    lastBatchChecksum: lastChecksum,
    manifestChecksum: input.checksum,
    status,
    operator: input.operator,
  });

  return {
    table: input.table.name,
    unscopedBefore,
    unscopedAfter,
    rowsUpdated,
    batchesCommitted,
    txids,
    lastChecksum,
    status,
  };
}

export async function runDomainBackfill(
  options: RunBackfillOptions,
): Promise<DomainBackfillResult> {
  assertSafeDatabaseUrl(options.databaseUrl, {
    confirm: options.args.confirm,
    nodeEnv: options.nodeEnv ?? process.env.NODE_ENV,
  });

  const manifest =
    options.manifest ??
    loadBackfillManifest(options.manifestPath ?? DEFAULT_MANIFEST);
  const domain = requireDomain(manifest, options.args.domain);
  const checksum = manifestChecksum(manifest);
  const operator = options.args.operator ?? process.env.OPS_OPERATOR ?? "unknown";
  const batchSize = options.args.batchSize ?? manifest.defaultBatchSize;
  const maxBatches = options.args.maxBatches ?? Number.MAX_SAFE_INTEGER;
  const mode = options.args.mode;

  const pool = new Pool({
    connectionString: options.databaseUrl,
    max: 1,
    lock_timeout: Number(process.env.OPS_LOCK_TIMEOUT_MS) || 5_000,
    statement_timeout: Number(process.env.OPS_STATEMENT_TIMEOUT_MS) || 60_000,
  });

  const client = await pool.connect();
  try {
    if (mode === "apply") {
      await client.query(PROGRESS_DDL);
    }

    const tables: TableBackfillResult[] = [];
    for (const table of domain.tables) {
      tables.push(
        await backfillTable(client, {
          manifest,
          domainName: options.args.domain,
          table,
          mode,
          batchSize,
          maxBatches,
          operator,
          checksum,
        }),
      );
    }

    return {
      domain: options.args.domain,
      mode,
      manifestChecksum: checksum,
      operator,
      tables,
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
    resolved.endsWith("ops-backfill.ts") || resolved.endsWith("ops-backfill.js")
  );
}

async function main(): Promise<void> {
  const args = parseBackfillArgs(process.argv.slice(2));
  const databaseUrl = process.env.DATABASE_URL ?? "";
  const result = await runDomainBackfill({
    databaseUrl,
    args,
    nodeEnv: process.env.NODE_ENV,
    manifestPath: args.manifestPath,
  });
  console.log(JSON.stringify(result, null, 2));
  if (result.mode === "apply") {
    const leftover = result.tables.filter((t) => t.unscopedAfter > 0);
    const interrupted = result.tables.some((t) => t.status === "interrupted");
    if (leftover.length > 0 && !interrupted) {
      const names = leftover
        .map((t) => `${t.table}:${t.unscopedAfter}`)
        .join(", ");
      throw new Error(
        `unscoped rows remain after apply (${names}). Re-run apply.`,
      );
    }
  }
}

if (isExecutedDirectly()) {
  main().catch((err: unknown) => {
    console.error("[ops-backfill] fatal:", err);
    process.exit(1);
  });
}
