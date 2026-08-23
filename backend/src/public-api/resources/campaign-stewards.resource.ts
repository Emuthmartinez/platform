/**
 * Recurso `api/public/campaign-stewards` — responsables de punto.
 *
 * El 201 de `create` trae el token en claro UNA vez. `list` y `get` nunca lo
 * traen: la base solo guarda su hash. `delete` no borra la fila, la desactiva,
 * para que las recepciones que esa persona confirmó sigan teniendo autor.
 */
import { z } from "zod";
import { createCrudRouter, type CrudResource } from "@/public-api/crud-factory";
import * as service from "@/services/campaign/admin-stewards";
import { requireTenantScope } from "@/middleware/tenant";

const createSchema = z.object({
  siteId: z.string().trim().min(1, "Indica el punto.").max(64),
  displayName: z.string().trim().min(1, "Indica el nombre de la persona.").max(120),
});

const responseSchema = z.object({
  id: z.string(),
  siteId: z.string(),
  siteName: z.string().nullable(),
  city: z.string().nullable(),
  displayName: z.string(),
  active: z.boolean(),
  createdAt: z.number(),
  token: z.string().optional(),
});

export const campaignStewardsResource: CrudResource<
  service.StewardDTO,
  service.StewardDTO,
  z.infer<typeof createSchema>,
  never
> = {
  capability: "campaign",
  auditType: "campaign_steward",
  schemas: { create: createSchema, response: responseSchema },
  ops: {
    list: () => service.listStewards(),
    get: (id) => service.getSteward(id),
    create: (input, req) => service.addSteward(input, requireTenantScope(req)),
    remove: (id) => service.deactivateSteward(id),
  },
};

export const publicCampaignStewardsRouter = createCrudRouter(campaignStewardsResource);
