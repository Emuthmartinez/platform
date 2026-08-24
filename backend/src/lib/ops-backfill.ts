/**
 * U8 Colombia tenant backfill — pure helpers.
 *
 * The apply loop lives in `backend/worker/ops-backfill.ts` (Node + pg).
 * Do not import that worker file from the Cloudflare Worker request path.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { z } from "zod";
import {
  COLOMBIA_INCIDENT_ID,
  COLOMBIA_ORGANIZATION_ID,
} from "@/lib/colombia-tenant";

export const REMOTE_CONFIRM = "colombia-u8-backfill";

export const LOCAL_DB_HOSTS = new Set([
  "localhost",
  "127.0.0.1",
  "db",
  "::1",
]);

const IDENT = /^[a-z][a-z0-9_]*$/;

const tableSchema = z.object({
  name: z.string().regex(IDENT),
  pk: z.array(z.string().regex(IDENT)).min(1),
});

const domainSchema = z.object({
  migration: z.string().min(1),
  tables: z.array(tableSchema).min(1),
});

export const backfillManifestSchema = z.object({
  version: z.literal(1),
  operationId: z.string().min(1),
  ktd: z.string().min(1),
  organizationId: z.literal(COLOMBIA_ORGANIZATION_ID),
  incidentId: z.literal(COLOMBIA_INCIDENT_ID),
  defaultBatchSize: z.number().int().positive(),
  domains: z.record(domainSchema),
});

export type BackfillTable = z.infer<typeof tableSchema>;
export type BackfillDomain = z.infer<typeof domainSchema>;
export type BackfillManifest = z.infer<typeof backfillManifestSchema>;

export type BackfillMode = "count-only" | "apply";

export interface BackfillArgs {
  domain: string;
  mode: BackfillMode;
  batchSize?: number;
  maxBatches?: number;
  confirm?: string;
  operator?: string;
  manifestPath?: string;
}

export function quoteIdent(name: string): string {
  if (!IDENT.test(name)) {
    throw new Error(`refusing identifier ${JSON.stringify(name)}`);
  }
  return `"${name}"`;
}

export function canonicalJson(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (v && typeof v === "object") {
      const obj = v as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(obj).sort()) {
        out[key] = sort(obj[key]);
      }
      return out;
    }
    return v;
  };
  return JSON.stringify(sort(value));
}

export function manifestChecksum(manifest: BackfillManifest): string {
  return createHash("sha256").update(canonicalJson(manifest)).digest("hex");
}

export function loadBackfillManifest(path: string): BackfillManifest {
  const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
  return backfillManifestSchema.parse(raw);
}

export function assertSafeDatabaseUrl(
  url: string,
  opts: { confirm?: string; nodeEnv?: string; expectedConfirm?: string },
): { host: string; local: boolean } {
  if (!url) {
    throw new Error("DATABASE_URL is not set");
  }
  if (/-pooler/i.test(url)) {
    throw new Error(
      "DATABASE_URL uses a pooler endpoint. Use the Neon direct endpoint.",
    );
  }
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    throw new Error("DATABASE_URL is not a valid URL");
  }
  const local = LOCAL_DB_HOSTS.has(host);
  const expectedConfirm = opts.expectedConfirm ?? REMOTE_CONFIRM;
  const confirmed = opts.confirm === expectedConfirm;
  if (!local && !confirmed) {
    throw new Error(
      `host "${host}" is not local. Pass --confirm ${expectedConfirm} to run against a remote direct endpoint.`,
    );
  }
  if (opts.nodeEnv === "production" && !confirmed) {
    throw new Error(
      `NODE_ENV=production requires --confirm ${expectedConfirm}`,
    );
  }
  return { host, local };
}

export function parseBackfillArgs(argv: string[]): BackfillArgs {
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

  const batchSize = raw["batch-size"]
    ? Number(raw["batch-size"])
    : undefined;
  if (batchSize !== undefined && (!Number.isInteger(batchSize) || batchSize < 1)) {
    throw new Error("--batch-size must be a positive integer");
  }

  const maxBatches = raw["max-batches"]
    ? Number(raw["max-batches"])
    : undefined;
  if (
    maxBatches !== undefined &&
    (!Number.isInteger(maxBatches) || maxBatches < 1)
  ) {
    throw new Error("--max-batches must be a positive integer");
  }

  return {
    domain,
    mode,
    batchSize,
    maxBatches,
    confirm: raw.confirm,
    operator: raw.operator,
    manifestPath: raw.manifest,
  };
}

export function buildUnscopedCountSql(table: string): string {
  const t = quoteIdent(table);
  return `SELECT count(*)::bigint AS n FROM ${t} WHERE organization_id IS NULL OR incident_id IS NULL`;
}

export function buildBatchUpdateSql(table: string, pk: string[]): string {
  const t = quoteIdent(table);
  const pkCols = pk.map(quoteIdent);
  const orderBy = pkCols.join(", ");
  const returning = pkCols.map((col) => `t.${col}`).join(", ");
  return `
WITH picked AS (
  SELECT ctid
    FROM ${t}
   WHERE organization_id IS NULL OR incident_id IS NULL
   ORDER BY ${orderBy}
   LIMIT $3
   FOR UPDATE SKIP LOCKED
)
UPDATE ${t} AS t
   SET organization_id = $1,
       incident_id = $2
  FROM picked
 WHERE t.ctid = picked.ctid
RETURNING ${returning}
`.trim();
}

export function checksumBatchRows(
  rows: Record<string, unknown>[],
  pk: string[],
): string {
  const payload = rows
    .map((row) => pk.map((col) => String(row[col] ?? "")).join("\t"))
    .sort()
    .join("\n");
  return createHash("sha256").update(payload).digest("hex");
}

export function cursorFromRow(
  row: Record<string, unknown>,
  pk: string[],
): string {
  const cursor: Record<string, string> = {};
  for (const col of pk) {
    cursor[col] = String(row[col] ?? "");
  }
  return JSON.stringify(cursor);
}

export function requireDomain(
  manifest: BackfillManifest,
  domainName: string,
): BackfillDomain {
  const domain = manifest.domains[domainName];
  if (!domain) {
    const known = Object.keys(manifest.domains).sort().join(", ");
    throw new Error(
      `unknown domain ${JSON.stringify(domainName)}. Known: ${known}`,
    );
  }
  return domain;
}
