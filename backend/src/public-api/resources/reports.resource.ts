import { z } from "zod";
import { createCrudRouter, type CrudResource } from "@/public-api/crud-factory";
import { requireTenantScope } from "@/middleware/tenant";
import * as service from "@/services/reports";

const reportType = z.enum(service.REPORT_TYPE_KEYS);

const createSchema = z.object({
  type: reportType,
  lat: z.coerce.number().min(-90).max(90),
  lng: z.coerce.number().min(-180).max(180),
  place: z.string().trim().min(1, "Indica el lugar.").max(200),
  affected: z.coerce.number().int().min(0).default(0),
  needs: z.string().max(1000).optional(),
});

const updateSchema = z
  .object({
    type: reportType.optional(),
    lat: z.coerce.number().min(-90).max(90).optional(),
    lng: z.coerce.number().min(-180).max(180).optional(),
    place: z.string().trim().min(1).max(200).optional(),
    affected: z.coerce.number().int().min(0).optional(),
    needs: z.string().max(1000).optional(),
  })
  .refine((o) => Object.keys(o).length > 0, "Envía al menos un campo a actualizar.");

const responseSchema = z.object({
  id: z.string(),
  type: reportType,
  lat: z.number(),
  lng: z.number(),
  place: z.string(),
  affected: z.number(),
  needs: z.string(),
  photoUrl: z.string().nullable(),
  confirmations: z.number(),
  createdAt: z.number(),
});

export const reportsResource: CrudResource<
  Awaited<ReturnType<typeof service.listReports>>[number],
  Awaited<ReturnType<typeof service.getReportById>>,
  z.infer<typeof createSchema>,
  z.infer<typeof updateSchema>
> = {
  capability: "report",
  schemas: { create: createSchema, update: updateSchema, response: responseSchema },
  ops: {
    list: () => service.listReports(),
    get: (id) => service.getReportById(id),
    create: (input, req) =>
      service.addReport({
        type: input.type,
        lat: input.lat,
        lng: input.lng,
        place: input.place,
        affected: input.affected,
        needs: input.needs,
        photo: null,
      }, requireTenantScope(req)),
    update: (id, input, req) =>
      service.updateReport(id, input, requireTenantScope(req)),
    remove: (id, req) =>
      service.removeReport(id, requireTenantScope(req)),
  },
};

export const publicReportsRouter = createCrudRouter(reportsResource);
