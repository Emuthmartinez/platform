/**
 * U8 operational tighten: CHECK/VALIDATE/SET NOT NULL/tenant indexes.
 * Uses local compose/CI Postgres only.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureSeed } from "./helpers";
import { getDb, schema } from "@/db";
import {
  COLOMBIA_INCIDENT_ID,
  COLOMBIA_ORGANIZATION_ID,
} from "@/lib/colombia-tenant";
import {
  assertSafeDatabaseUrl,
  loadBackfillManifest,
} from "@/lib/ops-backfill";
import {
  TIGHTEN_CONFIRM,
  allTightenTables,
  assertZeroUnscoped,
  buildAddCheckSql,
  buildCreateIndexConcurrentSql,
  buildCreateIndexSql,
  indexDefinitionMatches,
  parseTightenArgs,
  tenantIndexName,
} from "@/lib/ops-tighten";
import { runDomainTighten } from "../worker/ops-tighten";

const HERE = dirname(fileURLToPath(import.meta.url));
const MANIFEST_PATH = join(
  HERE,
  "../../infra/db/operations/u8-colombia-backfill.manifest.json",
);
const MIGRATION_PATH = join(HERE, "../../infra/db/migrations/0024_tenant_tighten.sql");
const WORKER_SRC = join(HERE, "../worker/ops-tighten.ts");
const PREFIX = "DEMO-u8t-";

function dbUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL missing in test env");
  return url;
}

describe("U8 ops-tighten guards", () => {
  it("refuses a remote host without the tighten confirm token", () => {
    expect(() =>
      assertSafeDatabaseUrl(
        "postgres://u:p@ep-example.us-east-1.aws.neon.tech/app",
        { expectedConfirm: TIGHTEN_CONFIRM, nodeEnv: "test" },
      ),
    ).toThrow(/not local/);
  });

  it("allows a remote direct URL with the tighten confirm token", () => {
    const result = assertSafeDatabaseUrl(
      "postgres://u:p@ep-example.us-east-1.aws.neon.tech/app",
      { confirm: TIGHTEN_CONFIRM, expectedConfirm: TIGHTEN_CONFIRM, nodeEnv: "production" },
    );
    expect(result.local).toBe(false);
  });

  it("parses CLI args and rejects an unknown mode", () => {
    expect(parseTightenArgs(["--domain", "reports", "--mode", "count-only"])).toEqual({
      domain: "reports",
      mode: "count-only",
      confirm: undefined,
      operator: undefined,
      manifestPath: undefined,
      replaceInvalidIndex: false,
    });
    expect(() =>
      parseTightenArgs(["--domain", "reports", "--mode", "wipe"]),
    ).toThrow(/invalid --mode/);
  });

  it("refuses leftover unscoped rows", () => {
    expect(() => assertZeroUnscoped("reports", 3)).toThrow(/unscoped row/);
    expect(() => assertZeroUnscoped("reports", 0)).not.toThrow();
  });

  it("builds NOT VALID checks and concurrent indexes; migration forbids CONCURRENTLY", () => {
    expect(buildAddCheckSql("reports", "organization_id")).toMatch(/NOT VALID/);
    expect(buildCreateIndexConcurrentSql("reports")).toMatch(/CONCURRENTLY/);
    expect(buildCreateIndexSql("reports")).not.toMatch(/CONCURRENTLY/);
    const migration = readFileSync(MIGRATION_PATH, "utf8").replace(
      /--[^\n]*/g,
      "",
    );
    expect(migration).not.toMatch(/CREATE INDEX CONCURRENTLY/);
    expect(migration).toMatch(/SET NOT NULL/);
    expect(migration).toMatch(/VALIDATE CONSTRAINT/);
    expect(migration).not.toMatch(/audit_log/);
  });

  it("matches tenant-leading index definitions", () => {
    expect(
      indexDefinitionMatches(
        'CREATE INDEX reports_tenant_scope_idx ON public.reports USING btree (organization_id, incident_id)',
        "reports",
      ),
    ).toBe(true);
    expect(
      indexDefinitionMatches(
        "CREATE INDEX reports_tenant_scope_idx ON reports USING btree (place)",
        "reports",
      ),
    ).toBe(false);
  });

  it("covers every backfill table and never audit_log", () => {
    const manifest = loadBackfillManifest(MANIFEST_PATH);
    const names = allTightenTables(manifest).map((t) => t.name);
    expect(names).toHaveLength(50);
    expect(names).not.toContain("audit_log");
    expect(names).toContain("reports");
    expect(names).toContain("campaign_sites");
    expect(names).toContain("click_counters");
  });

  it("does not import seedAuth or migrate.ts", () => {
    const src = readFileSync(WORKER_SRC, "utf8");
    expect(src).not.toMatch(/@\/auth\/seed/);
    expect(src).not.toMatch(/from ["']\.\/migrate/);
  });
});

describe("U8 ops-tighten reports domain", () => {
  const pool = new Pool({ connectionString: dbUrl(), max: 1 });

  beforeAll(async () => {
    await ensureSeed();
    await getDb().execute(sql`DELETE FROM reports WHERE id LIKE ${PREFIX + "%"}`);
  });

  afterAll(async () => {
    await getDb().execute(sql`DELETE FROM reports WHERE id LIKE ${PREFIX + "%"}`);
    await pool.end();
  });

  it("count-only fails closed when unscoped rows remain", async () => {
    const nullable = await pool.query<{ is_nullable: string }>(
      `SELECT is_nullable FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'reports'
          AND column_name = 'organization_id'`,
    );
    if (nullable.rows[0]?.is_nullable === "NO") {
      await expect(
        pool.query(
          `INSERT INTO reports (id, type, lat, lng, place, affected, needs, created_at)
           VALUES ($1,'need',4.6,-74.0,'DEMO u8t',0,'demo',$2)`,
          [`${PREFIX}reject`, Date.now()],
        ),
      ).rejects.toThrow(/null value|not-null|violates not-null/i);
      return;
    }
    await pool.query(
      `INSERT INTO reports (id, type, lat, lng, place, affected, needs, created_at)
       VALUES ($1,'need',4.6,-74.0,'DEMO u8t',0,'demo',$2)`,
      [`${PREFIX}unscoped`, Date.now()],
    );
    await expect(
      runDomainTighten({
        databaseUrl: dbUrl(),
        args: { domain: "reports", mode: "count-only", operator: "u8t-test" },
        nodeEnv: "test",
      }),
    ).rejects.toThrow(/unscoped row/);
    await pool.query(`DELETE FROM reports WHERE id = $1`, [`${PREFIX}unscoped`]);
  });

  it("apply validates FKs and creates a valid tenant-leading index", async () => {
    const result = await runDomainTighten({
      databaseUrl: dbUrl(),
      args: { domain: "reports", mode: "apply", operator: "u8t-test" },
      nodeEnv: "test",
    });
    expect(result.tables.every((t) => t.unscoped === 0)).toBe(true);
    expect(result.tables.every((t) => t.fkValidated)).toBe(true);
    expect(result.tables.every((t) => t.indexValid)).toBe(true);
    expect(result.tables.every((t) => t.status === "complete")).toBe(true);

    const idx = await pool.query<{ indisvalid: boolean; indexdef: string }>(
      `SELECT i.indisvalid, pg_get_indexdef(i.indexrelid) AS indexdef
         FROM pg_index i
         JOIN pg_class idx ON idx.oid = i.indexrelid
         JOIN pg_class tbl ON tbl.oid = i.indrelid
         JOIN pg_namespace n ON n.oid = tbl.relnamespace
        WHERE n.nspname = 'public'
          AND tbl.relname = 'reports'
          AND idx.relname = $1`,
      [tenantIndexName("reports")],
    );
    expect(idx.rows[0]?.indisvalid).toBe(true);
    expect(indexDefinitionMatches(idx.rows[0]?.indexdef ?? "", "reports")).toBe(true);
  });

  it("refuses a same-name index with the wrong definition", async () => {
    await pool.query(`DROP INDEX IF EXISTS ${tenantIndexName("reports")}`);
    await pool.query(
      `CREATE INDEX ${tenantIndexName("reports")} ON reports (place)`,
    );
    await expect(
      runDomainTighten({
        databaseUrl: dbUrl(),
        args: { domain: "reports", mode: "apply", operator: "u8t-test" },
        nodeEnv: "test",
      }),
    ).rejects.toThrow(/definition does not match/);
    await pool.query(`DROP INDEX IF EXISTS ${tenantIndexName("reports")}`);
    await runDomainTighten({
      databaseUrl: dbUrl(),
      args: { domain: "reports", mode: "apply", operator: "u8t-test" },
      nodeEnv: "test",
    });
  });

  it("journaled tighten makes tenant columns NOT NULL", async () => {
    const sqlText = readFileSync(MIGRATION_PATH, "utf8");
    await pool.query(sqlText);
    const cols = await pool.query<{ column_name: string; is_nullable: string }>(
      `SELECT column_name, is_nullable
         FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'reports'
          AND column_name IN ('organization_id','incident_id')
        ORDER BY column_name`,
    );
    expect(cols.rows).toEqual([
      { column_name: "incident_id", is_nullable: "NO" },
      { column_name: "organization_id", is_nullable: "NO" },
    ]);
    await expect(
      pool.query(
        `INSERT INTO reports (id, type, lat, lng, place, affected, needs, created_at)
         VALUES ($1,'need',4.6,-74.0,'DEMO u8t',0,'demo',$2)`,
        [`${PREFIX}bare`, Date.now()],
      ),
    ).rejects.toThrow(/null value|not-null|violates not-null/i);

    await getDb().insert(schema.reports).values({
      id: `${PREFIX}ok`,
      type: "need",
      lat: 4.6,
      lng: -74.0,
      place: "DEMO u8t",
      affected: 0,
      needs: "demo",
      createdAt: Date.now(),
      organizationId: COLOMBIA_ORGANIZATION_ID,
      incidentId: COLOMBIA_INCIDENT_ID,
    });
  });
});
