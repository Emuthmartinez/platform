import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import "./helpers";

process.env.PLATFORM_JWT_SECRET ??= "test-platform-jwt-secret-not-for-prod-0123456789";
process.env.PLATFORM_AUTH_MODE = "cloudflare_access";
process.env.PLATFORM_ACCESS_TEAM_DOMAIN = "mallanet-platform.cloudflareaccess.com";
process.env.PLATFORM_ACCESS_AUD = "synthetic-staging-audience";

vi.mock("@/platform-auth/access", () => ({
  verifyPlatformAccessAssertion: vi.fn(async (assertion: string) => {
    if (assertion === "valid-subject-one") return { email: operator.email, subject: "subject-one" };
    if (assertion === "valid-subject-two") return { email: operator.email, subject: "subject-two" };
    if (assertion === "unknown-email") return { email: "unknown@test.local", subject: "subject-unknown" };
    return null;
  }),
}));

const operator = { id: randomUUID(), email: `access-${randomUUID().slice(0, 8)}@test.local` };
let app: import("express").Express;

describe("platform Cloudflare Access exchange", () => {
  beforeAll(async () => {
    const { getDb, schema } = await import("@/db");
    const { hashPassword } = await import("@/auth/password");
    await getDb().insert(schema.platformOperators).values({
      ...operator,
      name: "Access Operator",
      passwordHash: await hashPassword(randomUUID()),
      status: "active",
      createdAt: Date.now(),
    });
    app = (await import("@/server")).app;
  });

  afterAll(async () => {
    const { getDb, schema } = await import("@/db");
    await getDb().delete(schema.platformAuditLog).where(eq(schema.platformAuditLog.actorOperatorId, operator.id));
    await getDb().delete(schema.platformOperators).where(eq(schema.platformOperators.id, operator.id));
  });

  it("never creates an operator from an asserted Google email", async () => {
    const response = await request(app).post("/api/platform/auth/access")
      .set("Cf-Access-Jwt-Assertion", "unknown-email");
    expect(response.status).toBe(401);
  });

  it("binds the first verified subject and rejects a later subject mismatch", async () => {
    const first = await request(app).post("/api/platform/auth/access")
      .set("Cf-Access-Jwt-Assertion", "valid-subject-one");
    expect(first.status).toBe(200);
    expect(first.body.token).toEqual(expect.any(String));

    const { getDb, schema } = await import("@/db");
    const [bound] = await getDb().select({ subject: schema.platformOperators.accessSubject })
      .from(schema.platformOperators).where(eq(schema.platformOperators.id, operator.id));
    expect(bound?.subject).toBe("subject-one");

    const mismatch = await request(app).post("/api/platform/auth/access")
      .set("Cf-Access-Jwt-Assertion", "valid-subject-two");
    expect(mismatch.status).toBe(401);
  });

  it("does not permit the password route in Access mode", async () => {
    const response = await request(app).post("/api/platform/auth/login")
      .send({ email: operator.email, password: "anything" });
    expect(response.status).toBe(401);
  });
});
