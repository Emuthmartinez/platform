import { Router } from "express";
import { z } from "zod";
import { asyncHandler, rateLimit, validate } from "@/middleware";
import { env } from "@/config/env";
import { serviceUnavailable, unauthorized } from "@/lib/errors";
import { logDbFailure } from "@/lib/db-error";
import { signPlatformToken } from "@/platform-auth/jwt";
import { sessionCookieOptions } from "@/auth/jwt";
import { requirePlatformOperator } from "@/platform-auth/middleware";
import { loginPlatformOperator } from "@/platform-auth/service";
import * as provisioning from "@/platform/provisioning-service";
import { writePlatformAudit } from "@/platform/audit";
import { getDb, schema } from "@/db";

export const platformRouter = Router();

const loginBody = z.object({ email: z.string().email(), password: z.string().min(1).max(256) });
const idParams = z.object({ id: z.string().uuid() });
const planBody = z.object({
  organization: z.object({ key: z.string().min(1).max(100), name: z.string().min(1).max(160) }),
  incident: z.object({ key: z.string().min(1).max(100), name: z.string().min(1).max(160) }),
  deployment: z.object({ key: z.string().min(1).max(120), hostname: z.string().min(1).max(253) }),
});

/**
 * @swagger
 * /api/platform/readyz:
 *   get:
 *     summary: Check control-plane schema readiness
 *     tags: [Platform Operations]
 *     responses:
 *       200: { description: Platform schema is queryable }
 *       503: { description: Platform schema or database is unavailable }
 * /api/platform/auth/login:
 *   post:
 *     summary: Sign in a platform operator
 *     tags: [Platform Operations]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email, password]
 *             properties:
 *               email: { type: string, format: email }
 *               password: { type: string, format: password }
 *     responses:
 *       200: { description: Platform session created }
 *       401: { description: Invalid platform operator credentials }
 * /api/platform/auth/logout:
 *   post:
 *     summary: Clear the platform session cookie
 *     tags: [Platform Operations]
 *     responses:
 *       200: { description: Platform session cleared }
 * /api/platform/auth/me:
 *   get:
 *     summary: Read the active platform operator
 *     tags: [Platform Operations]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Active platform operator }
 *       401: { description: Platform authentication required }
 * /api/platform/portfolio:
 *   get:
 *     summary: Read the global deployment portfolio
 *     tags: [Platform Operations]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Organizations, incidents, deployments, operators, runs, and audit events }
 * /api/platform/provisioning-runs:
 *   get:
 *     summary: List recent provisioning runs
 *     tags: [Platform Operations]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Recent provisioning runs }
 *   post:
 *     summary: Create or reuse a deterministic preview plan
 *     tags: [Platform Operations]
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [organization, incident, deployment]
 *             properties:
 *               organization: { type: object }
 *               incident: { type: object }
 *               deployment: { type: object }
 *     responses:
 *       201: { description: New deterministic plan created }
 *       200: { description: Existing planned run reused }
 *       400: { description: Invalid preview desired state }
 *       409: { description: Identical plan exists in a non-planned state }
 * /api/platform/provisioning-runs/{id}/approve:
 *   post:
 *     summary: Approve a plan created by another operator
 *     tags: [Platform Operations]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200: { description: Plan approved }
 *       403: { description: Creator cannot approve their own plan }
 * /api/platform/provisioning-runs/{id}/apply:
 *   post:
 *     summary: Apply automatic preview steps and stop before external activation
 *     tags: [Platform Operations]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200: { description: Run stopped at waiting_external }
 *       403: { description: Approver cannot apply the plan }
 *       409: { description: Plan or preview state conflicts with current state }
 */

platformRouter.get(
  "/readyz",
  rateLimit({ scope: "platform:readyz", limit: 120 }),
  asyncHandler(async (_req, res) => {
    try {
      await Promise.all([
        getDb().select({ id: schema.platformOperators.id }).from(schema.platformOperators).limit(1),
        getDb()
          .select({ id: schema.platformProvisioningRuns.id })
          .from(schema.platformProvisioningRuns)
          .limit(1),
      ]);
    } catch (err) {
      logDbFailure("platform.readyz", err);
      throw serviceUnavailable("Platform schema is unavailable.");
    }
    res.json({ ok: true, service: "mallanet-platform-api" });
  }),
);

// Platform login cannot require the session it creates; strict rate limiting is its gate.
// eslint-disable-next-line local/user-facing-mutation-needs-guard
platformRouter.post(
  "/auth/login",
  rateLimit({ scope: "platform:auth:login", limit: 10 }),
  validate({ body: loginBody }),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof loginBody>;
    const operator = await loginPlatformOperator(body.email, body.password);
    if (!operator) throw unauthorized("Invalid platform operator credentials.");
    const token = signPlatformToken(operator.id);
    res.cookie(env.PLATFORM_AUTH_COOKIE_NAME, token, sessionCookieOptions());
    await writePlatformAudit({ actorOperatorId: operator.id, action: "platform.auth.login" });
    res.json({ ok: true, token });
  }),
);

// Logout only clears the caller's httpOnly cookie.
// eslint-disable-next-line local/user-facing-mutation-needs-guard
platformRouter.post("/auth/logout", rateLimit({ scope: "platform:auth:logout", limit: 60 }), (_req, res) => {
  res.clearCookie(env.PLATFORM_AUTH_COOKIE_NAME, { ...sessionCookieOptions(), maxAge: undefined });
  res.json({ ok: true });
});

platformRouter.get(
  "/auth/me",
  rateLimit({ scope: "platform:auth:me", limit: 120 }),
  requirePlatformOperator,
  (req, res) => {
    res.set("Cache-Control", "no-store");
    res.json({ operator: req.platformOperator });
  },
);

platformRouter.get(
  "/portfolio",
  rateLimit({ scope: "platform:portfolio", limit: 120 }),
  requirePlatformOperator,
  asyncHandler(async (_req, res) => {
    res.json(await provisioning.portfolio());
  }),
);

platformRouter.get(
  "/provisioning-runs",
  rateLimit({ scope: "platform:runs:list", limit: 120 }),
  requirePlatformOperator,
  asyncHandler(async (_req, res) => {
    res.json({ items: await provisioning.listProvisioningRuns() });
  }),
);

platformRouter.post(
  "/provisioning-runs",
  rateLimit({ scope: "platform:runs:create", limit: 30 }),
  requirePlatformOperator,
  validate({ body: planBody }),
  asyncHandler(async (req, res) => {
    const result = await provisioning.createProvisioningRun(
      req.body as z.infer<typeof planBody>,
      req.platformOperator!.id,
    );
    const run = result.run;
    await writePlatformAudit({
      actorOperatorId: run.createdBy,
      action: "platform.provisioning.plan",
      targetType: "provisioning_run",
      targetId: run.id,
      metadata: { planDigest: run.planDigest, createdBy: run.createdBy },
      dedupeKey: `plan:${run.id}`,
    });
    if (!result.created) {
      await writePlatformAudit({
        actorOperatorId: req.platformOperator!.id,
        action: "platform.provisioning.plan.reused",
        targetType: "provisioning_run",
        targetId: run.id,
        metadata: { planDigest: run.planDigest, createdBy: run.createdBy },
        dedupeKey: `plan-reused:${run.id}:${req.platformOperator!.id}`,
      });
    }
    res.status(result.created ? 201 : 200).json({ item: run, created: result.created });
  }),
);

for (const action of ["approve", "apply"] as const) {
  platformRouter.post(
    `/provisioning-runs/:id/${action}`,
    rateLimit({ scope: `platform:runs:${action}`, limit: 30 }),
    requirePlatformOperator,
    validate({ params: idParams }),
    asyncHandler(async (req, res) => {
      const id = (req.params as { id: string }).id;
      const operatorId = req.platformOperator!.id;
      const item =
        action === "approve"
          ? await provisioning.approveProvisioningRun(id, operatorId)
          : await provisioning.applyProvisioningRun(id, operatorId);
      await writePlatformAudit({
        actorOperatorId: operatorId,
        action: `platform.provisioning.${action}`,
        targetType: "provisioning_run",
        targetId: id,
        dedupeKey: `${action}:${id}`,
      });
      res.json({ item });
    }),
  );
}
