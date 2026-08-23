/**
 * Recurso `api/public/volunteers` — CONFIG declarativa sobre la fábrica CRUD.
 * Registros de voluntarios del panel admin. La lógica/DB vive en
 * services/volunteers; la fábrica pone rate-limit, requireCapability,
 * validación y auditoría.
 *
 * Ops habilitadas: list/get/create + update (status/notes). Se OMITE `delete`:
 * un registro de voluntario es un registro humanitario (igual que la bandeja
 * de contacto) — no se borra por este endpoint; el estado se mueve a
 * `declined` en vez de eliminarse.
 */
import { z } from "zod";
import { createCrudRouter, type CrudResource } from "@/public-api/crud-factory";
import { VOLUNTEER_OFFER_TYPES } from "@/routes/volunteers";
import * as service from "@/services/volunteers";
import { requireTenantScope } from "@/middleware/tenant";

const statusEnum = z.enum(["pending", "contacted", "active", "declined"]);

const createSchema = z.object({
  name: z.string().trim().min(1, "Indica el nombre.").max(120),
  contact: z.string().trim().min(1, "Indica WhatsApp o correo.").max(120),
  offer: z.string().trim().max(2000).optional().default(""),
  zone: z.string().trim().min(1, "Indica la ciudad y país.").max(200),
  availability: z.string().trim().min(1, "Indica la disponibilidad.").max(120),
  offerTypes: z.array(z.enum(VOLUNTEER_OFFER_TYPES)).min(1).max(5),
  digitalSkills: z.array(z.string().trim().min(1).max(60)).max(10).optional(),
  crisisExperience: z.boolean().optional(),
  fieldCity: z.string().trim().max(200).optional(),
  rescueTraining: z.boolean().optional(),
  fieldRole: z.string().trim().max(120).optional(),
  ownVehicle: z.boolean().optional(),
  source: z.string().trim().max(500).optional(),
});

// Campos editables: status y notes (internas, solo admin). Al menos uno.
const updateSchema = z
  .object({
    status: statusEnum.optional(),
    notes: z.string().max(2000).optional(),
  })
  .refine((o) => Object.keys(o).length > 0, "Envía al menos un campo a actualizar.");

// DTO de SALIDA (lo que devuelve el service: VolunteerDTO). Solo para
// documentar la forma del retorno en /api/docs.
const responseSchema = z.object({
  id: z.string(),
  name: z.string(),
  contact: z.string(),
  code: z.string(),
  offer: z.string(),
  zone: z.string(),
  availability: z.string().nullable(),
  offerTypes: z.array(z.string()).nullable(),
  digitalSkills: z.array(z.string()).nullable(),
  crisisExperience: z.boolean().nullable(),
  fieldCity: z.string().nullable(),
  rescueTraining: z.boolean().nullable(),
  fieldRole: z.string().nullable(),
  ownVehicle: z.boolean().nullable(),
  source: z.string().nullable(),
  status: statusEnum,
  notes: z.string().nullable(),
  createdAt: z.number(),
  updatedAt: z.number().nullable(),
});

export const volunteersResource: CrudResource<
  Awaited<ReturnType<typeof service.listVolunteers>>[number],
  Awaited<ReturnType<typeof service.getVolunteerById>>,
  z.infer<typeof createSchema>,
  z.infer<typeof updateSchema>
> = {
  capability: "volunteer",
  schemas: { create: createSchema, update: updateSchema, response: responseSchema },
  ops: {
    list: () => service.listVolunteers(),
    get: (id) => service.getVolunteerById(id),
    create: async (input, req) => {
      // createVolunteer solo devuelve {id}; devolvemos el DTO completo.
      const { id } = await service.createVolunteer(input, requireTenantScope(req));
      const dto = await service.getVolunteerById(id);
      if (!dto) throw new Error("volunteer: el registro recién creado no se encontró");
      return dto;
    },
    update: (id, input) => service.updateVolunteer(id, input),
  },
};

export const publicVolunteersRouter = createCrudRouter(volunteersResource);
