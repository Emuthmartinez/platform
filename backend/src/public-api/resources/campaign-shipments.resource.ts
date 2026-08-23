/**
 * Recurso `api/public/campaign-shipments` — lotes hacia la zona afectada.
 * Lo que se registra aquí alimenta la cifra pública "en camino al Chocó".
 */
import { z } from "zod";
import { createCrudRouter, type CrudResource } from "@/public-api/crud-factory";
import { MATERIAL_KEYS } from "@/lib/campaign-materials";
import * as service from "@/services/campaign/admin-shipments";
import { requireTenantScope } from "@/middleware/tenant";

const SHIPMENT_STATUSES = ["loading", "in_transit", "delivered", "cancelled"] as const;

const itemSchema = z.object({
  material: z.enum(MATERIAL_KEYS),
  quantity: z.coerce.number().int().positive().max(1_000_000),
  unit: z.string().trim().max(40).optional().default(""),
});

const createSchema = z.object({
  originSiteId: z.string().trim().max(64).nullable().optional(),
  originCity: z.string().trim().min(1, "Indica la ciudad de origen.").max(120),
  destName: z.string().trim().min(1, "Indica el destino.").max(160),
  items: z.array(itemSchema).min(1, "Indica el material del lote.").max(20),
  status: z.enum(SHIPMENT_STATUSES).optional(),
  carrierNote: z.string().trim().max(500).optional(),
  departedAt: z.coerce.number().int().positive().nullable().optional(),
  arrivedAt: z.coerce.number().int().positive().nullable().optional(),
});

const updateSchema = createSchema.partial();

const responseSchema = z.object({
  id: z.string(),
  code: z.string(),
  originCity: z.string(),
  destName: z.string(),
  items: z.array(z.object({ material: z.string(), quantity: z.number(), unit: z.string() })),
  status: z.string(),
  carrierNote: z.string(),
  departedAt: z.number().nullable(),
  arrivedAt: z.number().nullable(),
  createdAt: z.number(),
});

export const campaignShipmentsResource: CrudResource<
  service.ShipmentDTO,
  service.ShipmentDTO,
  z.infer<typeof createSchema>,
  z.infer<typeof updateSchema>
> = {
  capability: "campaign",
  auditType: "campaign_shipment",
  schemas: { create: createSchema, update: updateSchema, response: responseSchema },
  ops: {
    list: () => service.listShipments(),
    get: (id) => service.getShipment(id),
    create: (input, req) =>
      service.createShipment({ ...input, items: input.items }, requireTenantScope(req)),
    update: (id, input) => service.updateShipment(id, input),
    remove: (id) => service.removeShipment(id),
  },
};

export const publicCampaignShipmentsRouter = createCrudRouter(campaignShipmentsResource);
