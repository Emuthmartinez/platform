/**
 * Volunteer analytics HTTP surface (WU3) — AuthZ, since, cache refresh, no PII.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import "./helpers";
import request from "supertest";
import { ensureSeed, makeAdmin, makeUserWithCaps, testTenantOwnership} from "./helpers";
import { invalidate } from "@/lib/cache";

let app: import("express").Express;

const FORBIDDEN_KEYS = [
  "name",
  "phone",
  "email",
  "document",
  "notes",
  "ip",
  "ipHash",
  "ip_hash",
  "contact",
  "offer",
] as const;

async function loadApp() {
  await ensureSeed();
  return (await import("@/server")).app;
}

function getAnalytics(token: string | null, query: Record<string, string> = {}) {
  const qs = new URLSearchParams(query).toString();
  const path = `/api/public/volunteer-analytics${qs ? `?${qs}` : ""}`;
  const req = request(app).get(path);
  if (token) req.set("Authorization", `Bearer ${token}`);
  return req;
}

async function insertDemoVolunteers(opts: {
  ids: string[];
  createdAt: number;
  status?: string;
  fieldRole?: string | null;
}) {
  const { getDb, schema } = await import("@/db");
  const db = getDb();
  const status = opts.status ?? "pending";
  for (let i = 0; i < opts.ids.length; i++) {
    const id = opts.ids[i]!;
    await db
      .insert(schema.volunteers)
      .values({
        id,
        name: `DEMO-vol-name-${i}`,
        contact: `+00-555-${1000 + i}`,
        offer: "DEMO-offer-should-not-leak",
        zone: "demo-zone",
        status,
        notes: "DEMO-notes-secret",
        ipHash: "demo-hash",
        createdAt: opts.createdAt + i,
        updatedAt: opts.createdAt + i,
        fieldRole: opts.fieldRole ?? "acopio",
        fieldCity: "Ciudad Central",
        availability: "parcial",
        source: "demo-seed",
        code: `DEMO-${id}`,
      ...testTenantOwnership(),
    })
      .onConflictDoNothing();
  }
}

async function cleanupDemo(ids: string[]) {
  const { getDb, schema } = await import("@/db");
  const { inArray } = await import("drizzle-orm");
  if (ids.length === 0) return;
  await getDb().delete(schema.volunteers).where(inArray(schema.volunteers.id, ids));
}

describe("GET /api/public/volunteer-analytics", () => {
  const demoIds: string[] = [];

  beforeAll(async () => {
    app = await loadApp();
  });

  beforeEach(() => {
    invalidate();
  });

  afterAll(async () => {
    await cleanupDemo(demoIds);
  });

  it("returns 401 without auth", async () => {
    const res = await getAnalytics(null);
    expect(res.status).toBe(401);
  });

  it("returns 403 without volunteer:read", async () => {
    const user = await makeUserWithCaps(["report:read"]);
    const res = await getAnalytics(user.token);
    expect(res.status).toBe(403);
  });

  it("returns 200 full-corpus aggregates for admin and omits PII keys", async () => {
    const id = `DEMO-vol-api-${Date.now()}`;
    demoIds.push(id);
    await insertDemoVolunteers({
      ids: [id],
      createdAt: Date.now() - 60_000,
      fieldRole: "acopio",
    });
    const admin = await makeAdmin();
    const res = await getAnalytics(admin.token);
    expect(res.status).toBe(200);
    expect(res.body.empty).toBe(false);
    expect(res.body.kpis.volunteers).toBeGreaterThanOrEqual(1);
    expect(res.body.kpis).toEqual(
      expect.objectContaining({
        pending: expect.any(Number),
        contacted: expect.any(Number),
        tasks: expect.any(Number),
        assignments: expect.any(Number),
      }),
    );
    expect(Array.isArray(res.body.callouts)).toBe(true);
    expect(res.body.cohort).toBeUndefined();

    const walk = (node: unknown): void => {
      if (Array.isArray(node)) {
        node.forEach(walk);
        return;
      }
      if (node && typeof node === "object") {
        for (const [k, child] of Object.entries(node as Record<string, unknown>)) {
          expect(FORBIDDEN_KEYS.includes(k as (typeof FORBIDDEN_KEYS)[number])).toBe(false);
          walk(child);
        }
      }
    };
    walk(res.body);
    expect(JSON.stringify(res.body)).not.toContain("DEMO-offer-should-not-leak");
    expect(JSON.stringify(res.body)).not.toContain("DEMO-vol-name");
  });

  it("accepts since and returns cohort.since for that window", async () => {
    const since = new Date(Date.now() - 30_000).toISOString();
    const id = `DEMO-vol-since-${Date.now()}`;
    demoIds.push(id);
    await insertDemoVolunteers({
      ids: [id],
      createdAt: Date.now() - 5_000,
      fieldRole: "salud",
    });
    const admin = await makeAdmin();
    const res = await getAnalytics(admin.token, { since });
    expect(res.status).toBe(200);
    expect(res.body.cohort).toEqual({ since });
    expect(res.body.kpis.volunteers).toBeGreaterThanOrEqual(1);
  });

  it("uses distinct cache keys and refresh=1 bypasses cache", async () => {
    const admin = await makeAdmin();
    const idA = `DEMO-vol-cache-a-${Date.now()}`;
    demoIds.push(idA);
    await insertDemoVolunteers({
      ids: [idA],
      createdAt: Date.now() - 10_000,
      fieldRole: "cocina",
    });

    const first = await getAnalytics(admin.token);
    expect(first.status).toBe(200);
    const firstCount = first.body.kpis.volunteers as number;

    const idB = `DEMO-vol-cache-b-${Date.now()}`;
    demoIds.push(idB);
    await insertDemoVolunteers({
      ids: [idB],
      createdAt: Date.now() - 1_000,
      fieldRole: "transporte",
    });

    // Without refresh, isolate cache may still serve the prior aggregate.
    const cached = await getAnalytics(admin.token);
    expect(cached.status).toBe(200);
    expect(cached.body.kpis.volunteers).toBe(firstCount);

    const refreshed = await getAnalytics(admin.token, { refresh: "1" });
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.kpis.volunteers).toBeGreaterThan(firstCount);
  });
});
