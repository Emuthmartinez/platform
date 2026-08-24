/**
 * U8 operational backfill: bounded committed batches, resume, dual-write
 * idempotency, and destination guards. Uses local compose/CI Postgres only.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ensureSeed } from "./helpers";
import { getDb, schema } from "@/db";
import {
  COLOMBIA_INCIDENT_ID,
  COLOMBIA_ORGANIZATION_ID,
  colombiaTenantScope,
} from "@/lib/colombia-tenant";
import {
  assertSafeDatabaseUrl,
  canonicalJson,
  loadBackfillManifest,
  manifestChecksum,
  parseBackfillArgs,
  quoteIdent,
  REMOTE_CONFIRM,
} from "@/lib/ops-backfill";
import { incidentOwnership } from "@/tenant/ownership";
import { runDomainBackfill } from "../worker/ops-backfill";

const HERE = dirname(fileURLToPath(import.meta.url));
const MANIFEST_PATH = join(
  HERE,
  "../../infra/db/operations/u8-colombia-backfill.manifest.json",
);
const WORKER_SRC = join(HERE, "../worker/ops-backfill.ts");
const PREFIX = "DEMO-u8-";

function dbUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL missing in test env");
  return url;
}

async function cleanupFixtures(): Promise<void> {
  const db = getDb();
  await db.execute(
    sql`DELETE FROM report_confirmations WHERE report_id LIKE ${PREFIX + "%"}`,
  );
  await db.execute(sql`DELETE FROM reports WHERE id LIKE ${PREFIX + "%"}`);
  await db.execute(sql`DELETE FROM chat_messages WHERE id LIKE ${PREFIX + "%"}`);
  await db.execute(
    sql`DELETE FROM contact_messages WHERE id LIKE ${PREFIX + "%"}`,
  );
  await db.execute(
    sql`DELETE FROM analytics_events WHERE id LIKE ${PREFIX + "%"}`,
  );
  await db.execute(
    sql`DELETE FROM damage_candidates WHERE id LIKE ${PREFIX + "%"}`,
  );
}

async function insertUnscopedReports(count: number): Promise<string[]> {
  const now = Date.now();
  const ids = Array.from({ length: count }, (_, i) => `${PREFIX}report-${i}`);
  await getDb()
    .insert(schema.reports)
    .values(
      ids.map((id) => ({
        id,
        type: "need",
        lat: 4.6,
        lng: -74.0,
        place: "DEMO U8 backfill fixture",
        affected: 0,
        needs: "demo",
        createdAt: now,
        organizationId: null,
        incidentId: null,
      })),
    );
  return ids;
}

describe("U8 ops-backfill guards", () => {
  it("refuses a pooler URL", () => {
    expect(() =>
      assertSafeDatabaseUrl(
        "postgres://u:p@ep-example-pooler.us-east-1.aws.neon.tech/app",
        { nodeEnv: "test" },
      ),
    ).toThrow(/pooler/);
  });

  it("refuses a remote host without the confirm token", () => {
    expect(() =>
      assertSafeDatabaseUrl(
        "postgres://u:p@ep-example.us-east-1.aws.neon.tech/app",
        { nodeEnv: "test" },
      ),
    ).toThrow(/not local/);
  });

  it("allows a remote direct URL with the confirm token", () => {
    const result = assertSafeDatabaseUrl(
      "postgres://u:p@ep-example.us-east-1.aws.neon.tech/app",
      { confirm: REMOTE_CONFIRM, nodeEnv: "production" },
    );
    expect(result.local).toBe(false);
    expect(result.host).toBe("ep-example.us-east-1.aws.neon.tech");
  });

  it("allows localhost without confirm", () => {
    expect(
      assertSafeDatabaseUrl("postgres://mapa_app:localdev@localhost:5432/app", {
        nodeEnv: "test",
      }).local,
    ).toBe(true);
  });

  it("parses CLI args and rejects an unknown mode", () => {
    expect(
      parseBackfillArgs(["--domain", "reports", "--mode", "count-only"]),
    ).toEqual({
      domain: "reports",
      mode: "count-only",
      batchSize: undefined,
      maxBatches: undefined,
      confirm: undefined,
      operator: undefined,
      manifestPath: undefined,
    });
    expect(() =>
      parseBackfillArgs(["--domain", "reports", "--mode", "wipe"]),
    ).toThrow(/invalid --mode/);
  });

  it("refuses unsafe SQL identifiers", () => {
    expect(() => quoteIdent("reports;drop table reports")).toThrow(
      /refusing identifier/,
    );
    expect(quoteIdent("report_confirmations")).toBe('"report_confirmations"');
  });

  it("loads the reports-domain manifest with Colombia IDs", () => {
    const manifest = loadBackfillManifest(MANIFEST_PATH);
    expect(manifest.organizationId).toBe(COLOMBIA_ORGANIZATION_ID);
    expect(manifest.incidentId).toBe(COLOMBIA_INCIDENT_ID);
    expect(manifest.domains.reports?.tables.map((t) => t.name)).toEqual([
      "analytics_events",
      "chat_messages",
      "contact_messages",
      "damage_candidates",
      "report_confirmations",
      "reports",
    ]);
    expect(manifestChecksum(manifest)).toHaveLength(64);
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it("does not import seedAuth or migrate.ts", () => {
    const src = readFileSync(WORKER_SRC, "utf8");
    expect(src).not.toMatch(/@\/auth\/seed/);
    expect(src).not.toMatch(/from ["']\.\/migrate/);
    expect(src).not.toMatch(/worker\/migrate/);
  });
});

describe("U8 ops-backfill reports domain", () => {
  beforeAll(async () => {
    await ensureSeed();
    await cleanupFixtures();
    await runDomainBackfill({
      databaseUrl: dbUrl(),
      args: {
        domain: "reports",
        mode: "apply",
        operator: "u8-test-setup",
      },
      nodeEnv: "test",
    });
  });

  beforeEach(async () => {
    await cleanupFixtures();
  });

  afterAll(async () => {
    await cleanupFixtures();
  });

  it("count-only does not stamp rows", async () => {
    const ids = await insertUnscopedReports(3);
    const counted = await runDomainBackfill({
      databaseUrl: dbUrl(),
      args: {
        domain: "reports",
        mode: "count-only",
        operator: "u8-test",
      },
      nodeEnv: "test",
    });
    const reports = counted.tables.find((t) => t.table === "reports");
    expect(reports?.unscopedBefore).toBeGreaterThanOrEqual(3);
    expect(reports?.rowsUpdated).toBe(0);
    expect(reports?.status).toBe("count-only");

    const rows = await getDb()
      .select({
        id: schema.reports.id,
        organizationId: schema.reports.organizationId,
        incidentId: schema.reports.incidentId,
      })
      .from(schema.reports)
      .where(inArray(schema.reports.id, ids));
    expect(
      rows.every((r) => r.organizationId === null && r.incidentId === null),
    ).toBe(true);
  });

  it("commits more than one bounded batch with distinct transaction ids", async () => {
    await insertUnscopedReports(5);
    const result = await runDomainBackfill({
      databaseUrl: dbUrl(),
      args: {
        domain: "reports",
        mode: "apply",
        batchSize: 2,
        operator: "u8-test",
      },
      nodeEnv: "test",
    });
    const reports = result.tables.find((t) => t.table === "reports");
    expect(reports?.rowsUpdated).toBe(5);
    expect(reports?.batchesCommitted).toBe(3);
    expect(reports?.unscopedAfter).toBe(0);
    expect(reports?.status).toBe("complete");
    expect(new Set(reports?.txids).size).toBe(3);
  });

  it("resumes from recorded progress after an interrupted apply", async () => {
    const ids = await insertUnscopedReports(5);
    const first = await runDomainBackfill({
      databaseUrl: dbUrl(),
      args: {
        domain: "reports",
        mode: "apply",
        batchSize: 2,
        maxBatches: 1,
        operator: "u8-test",
      },
      nodeEnv: "test",
    });
    const firstReports = first.tables.find((t) => t.table === "reports");
    expect(firstReports?.batchesCommitted).toBe(1);
    expect(firstReports?.rowsUpdated).toBe(2);
    expect(firstReports?.status).toBe("interrupted");
    expect(firstReports?.unscopedAfter).toBe(3);

    const afterFirst = await getDb()
      .select({
        id: schema.reports.id,
        organizationId: schema.reports.organizationId,
      })
      .from(schema.reports)
      .where(inArray(schema.reports.id, ids));
    expect(
      afterFirst.filter((r) => r.organizationId === COLOMBIA_ORGANIZATION_ID),
    ).toHaveLength(2);

    const second = await runDomainBackfill({
      databaseUrl: dbUrl(),
      args: {
        domain: "reports",
        mode: "apply",
        batchSize: 2,
        maxBatches: 1,
        operator: "u8-test",
      },
      nodeEnv: "test",
    });
    const secondReports = second.tables.find((t) => t.table === "reports");
    expect(secondReports?.rowsUpdated).toBe(2);
    expect(secondReports?.status).toBe("interrupted");

    const third = await runDomainBackfill({
      databaseUrl: dbUrl(),
      args: {
        domain: "reports",
        mode: "apply",
        batchSize: 2,
        operator: "u8-test",
      },
      nodeEnv: "test",
    });
    const thirdReports = third.tables.find((t) => t.table === "reports");
    expect(thirdReports?.unscopedAfter).toBe(0);
    expect(thirdReports?.status).toBe("complete");

    const done = await getDb()
      .select({
        organizationId: schema.reports.organizationId,
        incidentId: schema.reports.incidentId,
      })
      .from(schema.reports)
      .where(inArray(schema.reports.id, ids));
    expect(
      done.every(
        (r) =>
          r.organizationId === COLOMBIA_ORGANIZATION_ID &&
          r.incidentId === COLOMBIA_INCIDENT_ID,
      ),
    ).toBe(true);
  });

  it("stamps a dual-write window row and a leftover NULL row on re-run", async () => {
    await insertUnscopedReports(3);
    await runDomainBackfill({
      databaseUrl: dbUrl(),
      args: {
        domain: "reports",
        mode: "apply",
        batchSize: 2,
        maxBatches: 1,
        operator: "u8-test",
      },
      nodeEnv: "test",
    });

    const now = Date.now();
    const ownership = incidentOwnership(colombiaTenantScope());
    await getDb()
      .insert(schema.reports)
      .values({
        id: `${PREFIX}dual-write`,
        type: "need",
        lat: 4.6,
        lng: -74.0,
        place: "DEMO U8 dual-write fixture",
        affected: 0,
        needs: "demo",
        createdAt: now,
        ...ownership,
      });
    await getDb()
      .insert(schema.reports)
      .values({
        id: `${PREFIX}late-null`,
        type: "need",
        lat: 4.6,
        lng: -74.0,
        place: "DEMO U8 late null fixture",
        affected: 0,
        needs: "demo",
        createdAt: now,
        organizationId: null,
        incidentId: null,
      });

    const result = await runDomainBackfill({
      databaseUrl: dbUrl(),
      args: {
        domain: "reports",
        mode: "apply",
        batchSize: 10,
        operator: "u8-test",
      },
      nodeEnv: "test",
    });
    const reports = result.tables.find((t) => t.table === "reports");
    expect(reports?.unscopedAfter).toBe(0);
    expect(reports?.status).toBe("complete");

    const [dual] = await getDb()
      .select({
        organizationId: schema.reports.organizationId,
        incidentId: schema.reports.incidentId,
      })
      .from(schema.reports)
      .where(eq(schema.reports.id, `${PREFIX}dual-write`));
    const [late] = await getDb()
      .select({
        organizationId: schema.reports.organizationId,
        incidentId: schema.reports.incidentId,
      })
      .from(schema.reports)
      .where(eq(schema.reports.id, `${PREFIX}late-null`));
    expect(dual).toEqual(ownership);
    expect(late).toEqual(ownership);

    const again = await runDomainBackfill({
      databaseUrl: dbUrl(),
      args: {
        domain: "reports",
        mode: "apply",
        batchSize: 10,
        operator: "u8-test",
      },
      nodeEnv: "test",
    });
    expect(again.tables.find((t) => t.table === "reports")?.rowsUpdated).toBe(0);
  });

  it("backfills every reports-domain table including composite PKs", async () => {
    const now = Date.now();
    await getDb().insert(schema.reports).values({
      id: `${PREFIX}parent`,
      type: "need",
      lat: 4.6,
      lng: -74.0,
      place: "DEMO U8 parent",
      affected: 0,
      needs: "demo",
      createdAt: now,
      organizationId: null,
      incidentId: null,
    });
    await getDb().insert(schema.reportConfirmations).values({
      reportId: `${PREFIX}parent`,
      ipHash: "demo-ip-hash",
      createdAt: now,
      organizationId: null,
      incidentId: null,
    });
    await getDb().insert(schema.chatMessages).values({
      id: `${PREFIX}chat`,
      text: "DEMO U8 chat",
      createdAt: now,
      organizationId: null,
      incidentId: null,
    });
    await getDb().insert(schema.contactMessages).values({
      id: `${PREFIX}contact`,
      name: "DEMO U8",
      email: "demo-u8@test.local",
      subject: "demo",
      message: "demo",
      createdAt: now,
      organizationId: null,
      incidentId: null,
    });
    await getDb().insert(schema.analyticsEvents).values({
      id: `${PREFIX}analytics`,
      sessionId: "demo-session",
      type: "page",
      path: "/demo",
      createdAt: now,
      organizationId: null,
      incidentId: null,
    });
    await getDb().insert(schema.damageCandidates).values({
      id: `${PREFIX}damage`,
      buildingId: "demo-building",
      lat: 4.6,
      lng: -74.0,
      damageLevel: "unknown",
      createdAt: now,
      updatedAt: now,
      organizationId: null,
      incidentId: null,
    });

    const result = await runDomainBackfill({
      databaseUrl: dbUrl(),
      args: {
        domain: "reports",
        mode: "apply",
        batchSize: 50,
        operator: "u8-test",
      },
      nodeEnv: "test",
    });

    expect(result.tables.every((t) => t.unscopedAfter === 0)).toBe(true);
    expect(result.tables.every((t) => t.status === "complete")).toBe(true);
    expect(
      result.tables.find((t) => t.table === "report_confirmations")?.rowsUpdated,
    ).toBe(1);
  });
});
