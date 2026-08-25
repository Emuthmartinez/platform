import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import "./helpers";

process.env.PLATFORM_JWT_SECRET ??= "test-platform-jwt-secret-not-for-prod-0123456789";

const suffix = randomUUID().slice(0, 8);
const operatorA = { id: randomUUID(), email: `planner-${suffix}@test.local` };
const operatorB = { id: randomUUID(), email: `approver-${suffix}@test.local` };
const organizationKey = `demo-relief-${suffix}`;
const incidentKey = `demo-quake-${suffix}`;
const deploymentKey = `demo-quake-${suffix}-staging`;
let app: import("express").Express;
let tokenA: string;
let tokenB: string;
let runId: string;

describe("U23/U30/U32 platform control-plane integration", () => {
  beforeAll(async () => {
    const { getDb, schema } = await import("@/db");
    const { hashPassword } = await import("@/auth/password");
    const { signPlatformToken } = await import("@/platform-auth/jwt");
    const db = getDb();
    const now = Date.now();
    await db.insert(schema.platformOperators).values([
      {
        ...operatorA,
        name: "Planner",
        passwordHash: await hashPassword("synthetic-planner-password"),
        status: "active",
        createdAt: now,
      },
      {
        ...operatorB,
        name: "Approver",
        passwordHash: await hashPassword("synthetic-approver-password"),
        status: "active",
        createdAt: now,
      },
    ]);
    tokenA = signPlatformToken(operatorA.id);
    tokenB = signPlatformToken(operatorB.id);
    app = (await import("@/server")).app;
  });

  afterAll(async () => {
    const { getDb, schema } = await import("@/db");
    const db = getDb();
    if (runId) {
      await db
        .delete(schema.platformAuditLog)
        .where(eq(schema.platformAuditLog.targetId, runId));
      await db
        .delete(schema.platformDeploymentSpecs)
        .where(eq(schema.platformDeploymentSpecs.provisioningRunId, runId));
      await db
        .delete(schema.platformProvisioningRuns)
        .where(eq(schema.platformProvisioningRuns.id, runId));
    }
    await db
      .delete(schema.platformAuditLog)
      .where(inArray(schema.platformAuditLog.actorOperatorId, [operatorA.id, operatorB.id]));
    await db.delete(schema.incidents).where(eq(schema.incidents.id, `inc_${incidentKey.replaceAll("-", "_")}`));
    await db.delete(schema.organizations).where(eq(schema.organizations.id, `org_${organizationKey.replaceAll("-", "_")}`));
    await db
      .delete(schema.platformOperators)
      .where(inArray(schema.platformOperators.id, [operatorA.id, operatorB.id]));
  });

  it("requires platform authority and completes an idempotent preview-only apply", async () => {
    const { signToken } = await import("@/auth/jwt");
    const tenantDenied = await request(app)
      .get("/api/platform/auth/me")
      .set("Authorization", `Bearer ${signToken("tenant-user")}`);
    expect(tenantDenied.status).toBe(401);

    const desired = {
      organization: { key: organizationKey, name: `Demo Relief ${suffix}` },
      incident: { key: incidentKey, name: `Demo Quake ${suffix}` },
      deployment: { key: deploymentKey, hostname: `staging.${deploymentKey}.example.org` },
    };
    const invalidPlan = await request(app)
      .post("/api/platform/provisioning-runs")
      .set("Authorization", `Bearer ${tokenA}`)
      .send({
        ...desired,
        deployment: { ...desired.deployment, hostname: "terremotocolombia.co" },
      });
    expect(invalidPlan.status).toBe(400);
    expect(invalidPlan.body.error).toMatch(/preview or staging route/i);

    const planned = await request(app)
      .post("/api/platform/provisioning-runs")
      .set("Authorization", `Bearer ${tokenA}`)
      .send(desired);
    expect(planned.status).toBe(201);
    runId = planned.body.item.id as string;
    expect(planned.body.item.status).toBe("planned");

    const repeatedPlan = await request(app)
      .post("/api/platform/provisioning-runs")
      .set("Authorization", `Bearer ${tokenA}`)
      .send(desired);
    expect(repeatedPlan.status).toBe(200);
    expect(repeatedPlan.body.created).toBe(false);
    expect(repeatedPlan.body.item.id).toBe(runId);

    const selfApproval = await request(app)
      .post(`/api/platform/provisioning-runs/${runId}/approve`)
      .set("Authorization", `Bearer ${tokenA}`);
    expect(selfApproval.status).toBe(403);

    const approved = await request(app)
      .post(`/api/platform/provisioning-runs/${runId}/approve`)
      .set("Authorization", `Bearer ${tokenB}`);
    expect(approved.status).toBe(200);
    expect(approved.body.item.status).toBe("approved");

    const approverApply = await request(app)
      .post(`/api/platform/provisioning-runs/${runId}/apply`)
      .set("Authorization", `Bearer ${tokenB}`);
    expect(approverApply.status).toBe(403);

    // A partial create can leave the durable run without step rows because
    // Neon HTTP has no interactive transaction. Apply must repair them.
    const { getDb, schema } = await import("@/db");
    await getDb()
      .delete(schema.platformProvisioningSteps)
      .where(eq(schema.platformProvisioningSteps.runId, runId));

    const applied = await request(app)
      .post(`/api/platform/provisioning-runs/${runId}/apply`)
      .set("Authorization", `Bearer ${tokenA}`);
    expect(applied.status).toBe(200);
    expect(applied.body.item.status).toBe("waiting_external");
    expect(applied.body.item.steps.filter((step: { status: string }) => step.status === "complete"))
      .toHaveLength(3);
    expect(applied.body.item.steps.filter((step: { status: string }) => step.status === "waiting_external"))
      .toHaveLength(3);

    const resumed = await request(app)
      .post(`/api/platform/provisioning-runs/${runId}/apply`)
      .set("Authorization", `Bearer ${tokenA}`);
    expect(resumed.status).toBe(200);
    expect(resumed.body.item.status).toBe("waiting_external");

    const staleDuplicate = await request(app)
      .post("/api/platform/provisioning-runs")
      .set("Authorization", `Bearer ${tokenB}`)
      .send(desired);
    expect(staleDuplicate.status).toBe(409);
    expect(staleDuplicate.body.error).toMatch(/waiting_external/i);

    const specs = await getDb()
      .select()
      .from(schema.platformDeploymentSpecs)
      .where(
        and(
          eq(schema.platformDeploymentSpecs.key, deploymentKey),
          eq(schema.platformDeploymentSpecs.provisioningRunId, runId),
        ),
      );
    expect(specs).toHaveLength(1);
    const liveRoute = await getDb()
      .select()
      .from(schema.deployments)
      .where(eq(schema.deployments.hostname, desired.deployment.hostname));
    expect(liveRoute).toHaveLength(0);
  });

  it("rejects a preview spec whose hostname is already a live route", async () => {
    const { getDb, schema } = await import("@/db");
    const local = randomUUID().slice(0, 8);
    const orgKey = `live-org-${local}`;
    const incKey = `live-inc-${local}`;
    const orgId = `org_${orgKey.replaceAll("-", "_")}`;
    const incId = `inc_${incKey.replaceAll("-", "_")}`;
    const hostname = `staging.live-${local}.example.org`;
    const key = `live-${local}-staging`;
    let localRunId = "";
    try {
      await getDb().insert(schema.organizations).values({
        id: orgId,
        name: "Synthetic Live Org",
        createdAt: Date.now(),
      });
      await getDb().insert(schema.incidents).values({
        id: incId,
        organizationId: orgId,
        name: "Synthetic Live Incident",
        createdAt: Date.now(),
      });
      await getDb().insert(schema.deployments).values({
        hostname,
        organizationId: orgId,
        incidentId: incId,
        createdAt: Date.now(),
      });

      const planned = await request(app)
        .post("/api/platform/provisioning-runs")
        .set("Authorization", `Bearer ${tokenA}`)
        .send({
          organization: { key: orgKey, name: "Synthetic Live Org" },
          incident: { key: incKey, name: "Synthetic Live Incident" },
          deployment: { key, hostname },
        });
      expect(planned.status).toBe(201);
      localRunId = planned.body.item.id as string;
      expect(
        (
          await request(app)
            .post(`/api/platform/provisioning-runs/${localRunId}/approve`)
            .set("Authorization", `Bearer ${tokenB}`)
        ).status,
      ).toBe(200);
      const applied = await request(app)
        .post(`/api/platform/provisioning-runs/${localRunId}/apply`)
        .set("Authorization", `Bearer ${tokenA}`);
      expect(applied.status).toBe(409);
      expect(applied.body.error).toMatch(/live deployment route/i);
    } finally {
      if (localRunId) {
        await getDb()
          .delete(schema.platformAuditLog)
          .where(eq(schema.platformAuditLog.targetId, localRunId));
        await getDb()
          .delete(schema.platformProvisioningRuns)
          .where(eq(schema.platformProvisioningRuns.id, localRunId));
      }
      await getDb().delete(schema.deployments).where(eq(schema.deployments.hostname, hostname));
      await getDb().delete(schema.incidents).where(eq(schema.incidents.id, incId));
      await getDb().delete(schema.organizations).where(eq(schema.organizations.id, orgId));
    }
  });
});
