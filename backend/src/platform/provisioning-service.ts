import { createHash, randomUUID } from "node:crypto";
import { and, asc, desc, eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { conflict, notFound } from "@/lib/errors";
import { assertApplyAuthority, assertApprovalAuthority } from "@/platform/provisioning-authority";
import {
  buildProvisioningPlan,
  provisioningPlanSchema,
  provisioningPlanDigest,
  type ProvisioningPlan,
  type ProvisioningRequest,
} from "@/platform/provisioning-plan";

function stableId(prefix: string, key: string): string {
  const safe = key.replaceAll("-", "_");
  return `${prefix}_${safe}`.slice(0, 120);
}

function stepId(runId: string, key: string): string {
  return createHash("sha256").update(`${runId}:${key}`).digest("hex").slice(0, 32);
}

async function ensureProvisioningSteps(runId: string, plan: ProvisioningPlan, now: number) {
  await getDb()
    .insert(schema.platformProvisioningSteps)
    .values(
      plan.steps.map((step, ordinal) => ({
        id: stepId(runId, step.key),
        runId,
        key: step.key,
        ordinal,
        execution: step.execution,
        status: "pending",
        updatedAt: now,
      })),
    )
    .onConflictDoNothing();
}

export async function createProvisioningRun(
  desired: ProvisioningRequest,
  operatorId: string,
) {
  const plan = buildProvisioningPlan(desired);
  const planDigest = provisioningPlanDigest(plan);
  const db = getDb();
  const now = Date.now();
  const id = randomUUID();
  const [inserted] = await db
    .insert(schema.platformProvisioningRuns)
    .values({
      id,
      planDigest,
      status: "planned",
      desiredState: plan.desiredState,
      plan,
      createdBy: operatorId,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing({ target: schema.platformProvisioningRuns.planDigest })
    .returning({ id: schema.platformProvisioningRuns.id });
  if (!inserted) {
    const [existing] = await db
      .select({ id: schema.platformProvisioningRuns.id })
      .from(schema.platformProvisioningRuns)
      .where(eq(schema.platformProvisioningRuns.planDigest, planDigest))
      .limit(1);
    if (!existing) throw conflict("Provisioning plan collision could not be resolved.");
    let run = await getProvisioningRun(existing.id);
    if (run.status !== "planned") {
      throw conflict(`An identical plan already exists in state ${run.status}.`);
    }
    await ensureProvisioningSteps(existing.id, plan, now);
    run = await getProvisioningRun(existing.id);
    return { run, created: false };
  }
  await ensureProvisioningSteps(id, plan, now);
  return { run: await getProvisioningRun(id), created: true };
}

export async function getProvisioningRun(id: string) {
  const db = getDb();
  const [run] = await db
    .select()
    .from(schema.platformProvisioningRuns)
    .where(eq(schema.platformProvisioningRuns.id, id))
    .limit(1);
  if (!run) throw notFound("Provisioning run not found.");
  const steps = await db
    .select()
    .from(schema.platformProvisioningSteps)
    .where(eq(schema.platformProvisioningSteps.runId, id))
    .orderBy(asc(schema.platformProvisioningSteps.ordinal));
  return { ...run, steps };
}

export async function listProvisioningRuns() {
  return getDb()
    .select({
      id: schema.platformProvisioningRuns.id,
      status: schema.platformProvisioningRuns.status,
      planDigest: schema.platformProvisioningRuns.planDigest,
      createdBy: schema.platformProvisioningRuns.createdBy,
      approvedBy: schema.platformProvisioningRuns.approvedBy,
      createdAt: schema.platformProvisioningRuns.createdAt,
      approvedAt: schema.platformProvisioningRuns.approvedAt,
      updatedAt: schema.platformProvisioningRuns.updatedAt,
    })
    .from(schema.platformProvisioningRuns)
    .orderBy(desc(schema.platformProvisioningRuns.createdAt))
    .limit(50);
}

export async function approveProvisioningRun(id: string, operatorId: string) {
  const run = await getProvisioningRun(id);
  if (run.status === "approved" && run.approvedBy === operatorId) return run;
  assertApprovalAuthority(run, operatorId);
  const now = Date.now();
  const [approved] = await getDb()
    .update(schema.platformProvisioningRuns)
    .set({ status: "approved", approvedBy: operatorId, approvedAt: now, updatedAt: now })
    .where(
      and(
        eq(schema.platformProvisioningRuns.id, id),
        eq(schema.platformProvisioningRuns.status, "planned"),
      ),
    )
    .returning({ id: schema.platformProvisioningRuns.id });
  if (!approved) throw conflict("The run was changed before approval.");
  return getProvisioningRun(id);
}

async function completeStep(runId: string, key: string, detail?: Record<string, unknown>) {
  const [completed] = await getDb()
    .update(schema.platformProvisioningSteps)
    .set({ status: "complete", detail: detail ?? null, updatedAt: Date.now() })
    .where(
      and(
        eq(schema.platformProvisioningSteps.runId, runId),
        eq(schema.platformProvisioningSteps.key, key),
      ),
    )
    .returning({ id: schema.platformProvisioningSteps.id });
  if (!completed) throw conflict(`Provisioning step ${key} is missing.`);
}

export async function applyProvisioningRun(id: string, operatorId: string) {
  const run = await getProvisioningRun(id);
  assertApplyAuthority(run, operatorId);
  const parsedPlan = provisioningPlanSchema.safeParse(run.plan);
  if (!parsedPlan.success) throw conflict("Stored provisioning plan is malformed or unsupported.");
  const plan: ProvisioningPlan = parsedPlan.data;
  const expectedDigest = provisioningPlanDigest(plan);
  if (expectedDigest !== run.planDigest) throw conflict("Stored plan digest does not match.");
  const desired = plan.desiredState;
  const db = getDb();
  const now = Date.now();
  const [liveDeployment] = await db
    .select({ hostname: schema.deployments.hostname })
    .from(schema.deployments)
    .where(eq(schema.deployments.hostname, desired.deployment.hostname))
    .limit(1);
  if (liveDeployment) throw conflict("Hostname is already a live deployment route.");
  await ensureProvisioningSteps(id, plan, now);
  const refreshedRun = await getProvisioningRun(id);
  const stepStatus = new Map(refreshedRun.steps.map((step) => [step.key, step.status]));
  if (run.status !== "waiting_external") {
    await db
      .update(schema.platformProvisioningRuns)
      .set({ status: "applying", updatedAt: now })
      .where(eq(schema.platformProvisioningRuns.id, id));
  }

  const organizationId = stableId("org", desired.organization.key);
  if (stepStatus.get("organization.ensure") !== "complete") {
    await db
      .insert(schema.organizations)
      .values({ id: organizationId, name: desired.organization.name, createdAt: now })
      .onConflictDoNothing();
  }
  const [organization] = await db
    .select()
    .from(schema.organizations)
    .where(eq(schema.organizations.id, organizationId))
    .limit(1);
  if (!organization || organization.name !== desired.organization.name) {
    throw conflict("Organization stable key already belongs to different desired state.");
  }
  if (stepStatus.get("organization.ensure") !== "complete") {
    await completeStep(id, "organization.ensure", { organizationId });
  }

  const incidentId = stableId("inc", desired.incident.key);
  if (stepStatus.get("incident.ensure") !== "complete") {
    await db
      .insert(schema.incidents)
      .values({
        id: incidentId,
        organizationId,
        name: desired.incident.name,
        createdAt: now,
      })
      .onConflictDoNothing();
  }
  const [incident] = await db
    .select()
    .from(schema.incidents)
    .where(eq(schema.incidents.id, incidentId))
    .limit(1);
  if (
    !incident ||
    incident.organizationId !== organizationId ||
    incident.name !== desired.incident.name
  ) {
    throw conflict("Incident stable key already belongs to different desired state.");
  }
  if (stepStatus.get("incident.ensure") !== "complete") {
    await completeStep(id, "incident.ensure", { incidentId });
  }

  if (stepStatus.get("deployment.preview.ensure") !== "complete") {
    await db
      .insert(schema.platformDeploymentSpecs)
      .values({
        key: desired.deployment.key,
        organizationKey: desired.organization.key,
        incidentKey: desired.incident.key,
        hostname: desired.deployment.hostname,
        lifecycle: "preview",
        provisioningRunId: id,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing();
  }
  const [deploymentSpec] = await db
    .select()
    .from(schema.platformDeploymentSpecs)
    .where(eq(schema.platformDeploymentSpecs.key, desired.deployment.key))
    .limit(1);
  if (
    !deploymentSpec ||
    deploymentSpec.hostname !== desired.deployment.hostname ||
    deploymentSpec.organizationKey !== desired.organization.key ||
    deploymentSpec.incidentKey !== desired.incident.key ||
    deploymentSpec.lifecycle !== "preview"
  ) {
    throw conflict("Deployment stable key already belongs to different desired state.");
  }
  if (stepStatus.get("deployment.preview.ensure") !== "complete") {
    await completeStep(id, "deployment.preview.ensure", { routable: false });
  }

  await db
    .update(schema.platformProvisioningSteps)
    .set({ status: "waiting_external", updatedAt: now })
    .where(
      and(
        eq(schema.platformProvisioningSteps.runId, id),
        eq(schema.platformProvisioningSteps.execution, "external"),
        eq(schema.platformProvisioningSteps.status, "pending"),
      ),
    );
  const externalSteps = await db
    .select({ status: schema.platformProvisioningSteps.status })
    .from(schema.platformProvisioningSteps)
    .where(
      and(
        eq(schema.platformProvisioningSteps.runId, id),
        eq(schema.platformProvisioningSteps.execution, "external"),
      ),
    );
  if (
    externalSteps.length !== 3 ||
    externalSteps.some((step) => step.status !== "waiting_external")
  ) {
    throw conflict("Provisioning external steps are incomplete.");
  }
  if (run.status !== "waiting_external") {
    await db
      .update(schema.platformProvisioningRuns)
      .set({ status: "waiting_external", updatedAt: Date.now() })
      .where(eq(schema.platformProvisioningRuns.id, id));
  }
  return getProvisioningRun(id);
}

export async function portfolio(options?: { includeOperators?: boolean; includeAudit?: boolean }) {
  const db = getDb();
  const [
    organizations,
    incidents,
    activeHostnames,
    previewDeployments,
    recentRuns,
    operators,
    auditEvents,
  ] = await Promise.all([
      db
        .select({ id: schema.organizations.id, name: schema.organizations.name })
        .from(schema.organizations)
        .orderBy(asc(schema.organizations.name)),
      db
        .select({
          id: schema.incidents.id,
          organizationId: schema.incidents.organizationId,
          name: schema.incidents.name,
        })
        .from(schema.incidents)
        .orderBy(asc(schema.incidents.name)),
      db
        .select({
          hostname: schema.deployments.hostname,
          organizationId: schema.deployments.organizationId,
          incidentId: schema.deployments.incidentId,
        })
        .from(schema.deployments)
        .orderBy(asc(schema.deployments.hostname)),
      db
        .select({
          key: schema.platformDeploymentSpecs.key,
          hostname: schema.platformDeploymentSpecs.hostname,
          lifecycle: schema.platformDeploymentSpecs.lifecycle,
        })
        .from(schema.platformDeploymentSpecs)
        .orderBy(asc(schema.platformDeploymentSpecs.hostname)),
      listProvisioningRuns(),
      options?.includeOperators ? db
        .select({
          id: schema.platformOperators.id,
          email: schema.platformOperators.email,
          name: schema.platformOperators.name,
          status: schema.platformOperators.status,
          createdAt: schema.platformOperators.createdAt,
          lastLoginAt: schema.platformOperators.lastLoginAt,
        })
        .from(schema.platformOperators)
        .orderBy(asc(schema.platformOperators.email)) : Promise.resolve([]),
      options?.includeAudit ? db
        .select({
          id: schema.platformAuditLog.id,
          actorOperatorId: schema.platformAuditLog.actorOperatorId,
          action: schema.platformAuditLog.action,
          targetType: schema.platformAuditLog.targetType,
          targetId: schema.platformAuditLog.targetId,
          createdAt: schema.platformAuditLog.createdAt,
        })
        .from(schema.platformAuditLog)
        .orderBy(desc(schema.platformAuditLog.createdAt))
        .limit(50) : Promise.resolve([]),
    ]);
  return {
    organizations,
    incidents,
    activeHostnames,
    previewDeployments,
    recentRuns,
    operators,
    auditEvents,
  };
}
