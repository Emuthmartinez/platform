/**
 * Recurso `api/public/campaign-sites` — puntos de recolección de la campaña.
 * CONFIG declarativa sobre la fábrica CRUD: la fábrica pone rate-limit,
 * requireCapability, validación y auditoría.
 */
import { z } from "zod";
import { createCrudRouter, type CrudResource } from "@/public-api/crud-factory";
import { MATERIAL_KEYS } from "@/lib/campaign-materials";
import * as service from "@/services/campaign/admin-sites";
import { requireTenantScope } from "@/middleware/tenant";

const SITE_STATUSES = ["active", "paused", "full", "closed"] as const;

const createSchema = z.object({
  name: z.string().trim().min(1, "Indica el nombre del punto.").max(160),
  city: z.string().trim().min(1, "Indica la ciudad.").max(120),
  address: z.string().trim().max(300).optional(),
  schedule: z.string().trim().max(200).optional(),
  publicContact: z.string().trim().max(160).optional(),
  accepts: z.array(z.enum(MATERIAL_KEYS)).max(10).optional(),
  status: z.enum(SITE_STATUSES).optional(),
  note: z.string().trim().max(1000).optional(),
  lat: z.coerce.number().min(-90).max(90).nullable().optional(),
  lng: z.coerce.number().min(-180).max(180).nullable().optional(),
});

const updateSchema = createSchema.partial();

const responseSchema = z.object({
  id: z.string(),
  name: z.string(),
  city: z.string(),
  address: z.string(),
  schedule: z.string(),
  publicContact: z.string(),
  accepts: z.array(z.string()),
  status: z.string(),
  note: z.string(),
  lat: z.number().nullable(),
  lng: z.number().nullable(),
  createdAt: z.number(),
});

export const campaignSitesResource: CrudResource<
  service.SiteDTO,
  service.SiteDTO,
  z.infer<typeof createSchema>,
  z.infer<typeof updateSchema>
> = {
  capability: "campaign",
  auditType: "campaign_site",
  schemas: { create: createSchema, update: updateSchema, response: responseSchema },
  ops: {
    list: () => service.listSites(),
    get: (id) => service.getSite(id),
    create: (input, req) => service.createSite(input, requireTenantScope(req)),
    update: (id, input) => service.updateSite(id, input),
    remove: (id) => service.removeSite(id),
  },
};

export const publicCampaignSitesRouter = createCrudRouter(campaignSitesResource);
