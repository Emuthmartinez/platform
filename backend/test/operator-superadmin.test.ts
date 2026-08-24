/**
 * Superadmin operator surface: is_super_admin promotion and the hostname
 * catalog (deployment:manage). Regression: a seed-admin without the flag
 * must not pass those gates.
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import "./helpers";
import request from "supertest";
import { ensureSeed, makeAdmin, makeSuperAdmin, makeUserWithCaps } from "./helpers";
import {
  COLOMBIA_PRODUCTION_DB_MARKERS,
  OPERATOR_CONFIRM,
  assertNotColombiaProductionDatabase,
  normalizeOperatorEmail,
} from "@/lib/ops-ensure-superadmin";
import { COLOMBIA_INCIDENT_ID, COLOMBIA_ORGANIZATION_ID } from "@/lib/colombia-tenant";
import { DEPLOYMENT_MANAGE } from "@/auth/capabilities";
import { protectedHostnames } from "@/services/deployments";

let app: import("express").Express;
const extraHost = `demo-op-${randomUUID().slice(0, 8)}.example.org`;

beforeAll(async () => {
  await ensureSeed();
  app = (await import("@/server")).app;
});

afterAll(async () => {
  const { getDb, schema } = await import("@/db");
  await getDb().delete(schema.deployments).where(eq(schema.deployments.hostname, extraHost));
});

describe("ops-ensure-superadmin guards", () => {
  it("refuses Colombia production Neon markers", () => {
    expect(() =>
      assertNotColombiaProductionDatabase(
        `postgres://u:p@ep-${COLOMBIA_PRODUCTION_DB_MARKERS[0]}-axx.neon.tech/neondb`,
      ),
    ).toThrow(/production Neon/);
  });

  it("normalizes operator email", () => {
    expect(normalizeOperatorEmail("  Operator@Example.ORG ")).toBe("operator@example.org");
    expect(() => normalizeOperatorEmail("nope")).toThrow(/valid email/);
  });

  it("confirm token is the operator bootstrap token", () => {
    expect(OPERATOR_CONFIRM).toBe("platform-operator-bootstrap");
  });
});

describe("superadmin promotion", () => {
  it("GET /me exposes isSuperAdmin", async () => {
    const admin = await makeAdmin();
    const superadmin = await makeSuperAdmin();
    const adminMe = await request(app)
      .get("/api/public/auth/me")
      .set("Authorization", `Bearer ${admin.token}`);
    const superMe = await request(app)
      .get("/api/public/auth/me")
      .set("Authorization", `Bearer ${superadmin.token}`);
    expect(adminMe.status).toBe(200);
    expect(adminMe.body.user.isSuperAdmin).toBe(false);
    expect(adminMe.body.capabilities).toEqual(["*"]);
    expect(superMe.status).toBe(200);
    expect(superMe.body.user.isSuperAdmin).toBe(true);
    expect(superMe.body.capabilities).toEqual(expect.arrayContaining(["*", DEPLOYMENT_MANAGE]));
  });

  it("seed admin cannot set isSuperAdmin", async () => {
    const admin = await makeAdmin();
    const target = await makeUserWithCaps(["user:read"]);
    const res = await request(app)
      .patch(`/api/public/users/${target.id}`)
      .set("Authorization", `Bearer ${admin.token}`)
      .send({ isSuperAdmin: true });
    expect(res.status).toBe(403);
  });

  it("superadmin can promote another user", async () => {
    const superadmin = await makeSuperAdmin();
    const target = await makeUserWithCaps(["user:read"]);
    const res = await request(app)
      .patch(`/api/public/users/${target.id}`)
      .set("Authorization", `Bearer ${superadmin.token}`)
      .send({ isSuperAdmin: true });
    expect(res.status).toBe(200);
    expect(res.body.item.isSuperAdmin).toBe(true);
  });

  it("refuses demoting the last active superadmin", async () => {
    const { getDb, schema } = await import("@/db");
    const db = getDb();
    const prior = await db
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.isSuperAdmin, true));
    await db.update(schema.users).set({ isSuperAdmin: false }).where(eq(schema.users.isSuperAdmin, true));
    const last = await makeSuperAdmin();
    try {
      const res = await request(app)
        .patch(`/api/public/users/${last.id}`)
        .set("Authorization", `Bearer ${last.token}`)
        .send({ isSuperAdmin: false });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/último superadmin/);
    } finally {
      for (const row of prior) {
        await db.update(schema.users).set({ isSuperAdmin: true }).where(eq(schema.users.id, row.id));
      }
    }
  });
});

describe("deployment catalog", () => {
  it("seed admin is denied", async () => {
    const admin = await makeAdmin();
    const res = await request(app)
      .get("/api/public/deployments")
      .set("Authorization", `Bearer ${admin.token}`);
    expect(res.status).toBe(403);
  });

  it("role grant of deployment:manage does not pass without the flag", async () => {
    const user = await makeUserWithCaps([DEPLOYMENT_MANAGE]);
    const res = await request(app)
      .get("/api/public/deployments")
      .set("Authorization", `Bearer ${user.token}`);
    expect(res.status).toBe(403);
  });

  it("superadmin can create, list, and delete a non-live hostname", async () => {
    const superadmin = await makeSuperAdmin();
    const created = await request(app)
      .post("/api/public/deployments")
      .set("Authorization", `Bearer ${superadmin.token}`)
      .send({
        hostname: extraHost.toUpperCase() + ".",
        organizationId: COLOMBIA_ORGANIZATION_ID,
        incidentId: COLOMBIA_INCIDENT_ID,
      });
    expect(created.status).toBe(201);
    expect(created.body.item.hostname).toBe(extraHost);

    const listed = await request(app)
      .get("/api/public/deployments")
      .set("Authorization", `Bearer ${superadmin.token}`);
    expect(listed.status).toBe(200);
    expect(listed.body.items.some((row: { hostname: string }) => row.hostname === extraHost)).toBe(
      true,
    );

    const mixed = await request(app)
      .post("/api/public/deployments")
      .set("Authorization", `Bearer ${superadmin.token}`)
      .send({
        hostname: `demo-mixed-${randomUUID().slice(0, 8)}.example.org`,
        organizationId: COLOMBIA_ORGANIZATION_ID,
        incidentId: "inc_does_not_exist",
      });
    expect(mixed.status).toBe(400);

    const deleted = await request(app)
      .delete(`/api/public/deployments/${extraHost}`)
      .set("Authorization", `Bearer ${superadmin.token}`);
    expect(deleted.status).toBe(200);
    expect(deleted.body.ok).toBe(true);
  });

  it("refuses deleting a hostname this process is pinned to", async () => {
    expect(protectedHostnames("localhost").has("localhost")).toBe(true);
    const superadmin = await makeSuperAdmin();
    const res = await request(app)
      .delete("/api/public/deployments/localhost")
      .set("Authorization", `Bearer ${superadmin.token}`);
    expect(res.status).toBe(400);
  });
});
