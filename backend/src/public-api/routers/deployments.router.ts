/**
 * Router `api/public/deployments` — catálogo hostname → org/incidente (KTD7).
 *
 *   GET    /                lista deployments + orgs/incidents
 *   POST   /                crea un hostname
 *   PATCH  /:hostname       cambia org/incidente
 *   DELETE /:hostname       borra (no el hostname en uso)
 *
 * Gateado por `requireCapability("deployment:manage")` — corte is_super_admin
 * en auth/resolve.ts, igual que mirror:manage. Sesión humana; no API key.
 */
import { Router } from "express";
import { z } from "zod";
import { asyncHandler, rateLimit, validate } from "@/middleware";
import { requireCapability } from "@/middleware/auth";
import { writeAudit } from "@/auth/audit";
import { DEPLOYMENT_MANAGE } from "@/auth/capabilities";
import { forbidden, notFound } from "@/lib/errors";
import { trustedHostnameFromRequest } from "@/middleware/tenant";
import * as service from "@/services/deployments";

export const deploymentsRouter = Router();

const hostnameParams = z.object({
  hostname: z.string().min(1, "Falta el hostname.").max(253),
});
const writeBody = z.object({
  hostname: z.string().trim().min(1).max(253),
  organizationId: z.string().trim().min(1).max(120),
  incidentId: z.string().trim().min(1).max(120),
});
const patchBody = z
  .object({
    organizationId: z.string().trim().min(1).max(120).optional(),
    incidentId: z.string().trim().min(1).max(120).optional(),
  })
  .refine((o) => Object.keys(o).length > 0, "Envía al menos un campo a actualizar.");

function denyIfApiKeySession(req: { user?: { apiKeyScopes?: string[] } }): void {
  if (req.user?.apiKeyScopes) {
    throw forbidden("Gestiona deployments desde una sesión iniciada (no con una API key).");
  }
}

deploymentsRouter.get(
  "/",
  rateLimit({ scope: "public:deployment:list", limit: 120 }),
  requireCapability(DEPLOYMENT_MANAGE),
  asyncHandler(async (_req, res) => {
    res.json(await service.listDeploymentCatalog());
  }),
);

deploymentsRouter.post(
  "/",
  rateLimit({ scope: "public:deployment:create", limit: 30 }),
  requireCapability(DEPLOYMENT_MANAGE),
  validate({ body: writeBody }),
  asyncHandler(async (req, res) => {
    denyIfApiKeySession(req);
    const body = req.body as z.infer<typeof writeBody>;
    const item = await service.createDeployment(body);
    await writeAudit(req, {
      action: "deployment.create",
      targetType: "deployment",
      targetId: item.hostname,
      metadata: { organizationId: item.organizationId, incidentId: item.incidentId },
    });
    res.status(201).json({ item });
  }),
);

deploymentsRouter.patch(
  "/:hostname",
  rateLimit({ scope: "public:deployment:edit", limit: 30 }),
  requireCapability(DEPLOYMENT_MANAGE),
  validate({ params: hostnameParams, body: patchBody }),
  asyncHandler(async (req, res) => {
    denyIfApiKeySession(req);
    const { hostname } = req.params as { hostname: string };
    const body = req.body as z.infer<typeof patchBody>;
    const item = await service.updateDeployment(hostname, body);
    if (!item) throw notFound("Deployment no encontrado.");
    await writeAudit(req, {
      action: "deployment.edit",
      targetType: "deployment",
      targetId: item.hostname,
      metadata: { fields: Object.keys(body) },
    });
    res.json({ item });
  }),
);

deploymentsRouter.delete(
  "/:hostname",
  rateLimit({ scope: "public:deployment:delete", limit: 30 }),
  requireCapability(DEPLOYMENT_MANAGE),
  validate({ params: hostnameParams }),
  asyncHandler(async (req, res) => {
    denyIfApiKeySession(req);
    const { hostname } = req.params as { hostname: string };
    const ok = await service.deleteDeployment(hostname, trustedHostnameFromRequest(req));
    if (!ok) throw notFound("Deployment no encontrado.");
    await writeAudit(req, {
      action: "deployment.delete",
      targetType: "deployment",
      targetId: hostname,
    });
    res.json({ ok: true });
  }),
);
