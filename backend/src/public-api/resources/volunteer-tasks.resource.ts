/**
 * Recurso `api/public/volunteer-tasks` — tablero de tareas del panel.
 * CONFIG declarativa sobre la fábrica CRUD; la lógica vive en
 * services/volunteer-tasks. Reutiliza las capacidades volunteer:* (quien
 * gestiona voluntarios gestiona sus tareas) — sin entradas nuevas en el
 * catálogo. Sin `delete`: una tarea se cancela por estado, no se borra.
 */
import { z } from "zod";
import { createCrudRouter, type CrudResource } from "@/public-api/crud-factory";
import * as service from "@/services/volunteer-tasks";
import { requireTenantScope } from "@/middleware/tenant";

const kindEnum = z.enum(["digital", "terreno"]);
const statusEnum = z.enum(["open", "assigned", "done", "cancelled"]);
const lat = z.number().min(-90).max(90);
const lng = z.number().min(-180).max(180);

const createSchema = z.object({
  title: z.string().trim().min(1, "Indica el título.").max(200),
  description: z.string().trim().max(2000).optional().default(""),
  kind: kindEnum,
  city: z.string().trim().max(200).optional(),
  originName: z.string().trim().max(200).optional(),
  originLat: lat.optional(),
  originLng: lng.optional(),
  destName: z.string().trim().max(200).optional(),
  destLat: lat.optional(),
  destLng: lng.optional(),
  transportNote: z.string().trim().max(500).optional(),
});

const updateSchema = z
  .object({
    status: statusEnum.optional(),
    transportNote: z.string().trim().max(500).optional(),
    description: z.string().trim().max(2000).optional(),
  })
  .refine((o) => Object.keys(o).length > 0, "Envía al menos un campo a actualizar.");

const responseSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  kind: z.string(),
  city: z.string().nullable(),
  originName: z.string().nullable(),
  originLat: z.number().nullable(),
  originLng: z.number().nullable(),
  destName: z.string().nullable(),
  destLat: z.number().nullable(),
  destLng: z.number().nullable(),
  transportNote: z.string().nullable(),
  status: statusEnum,
  createdAt: z.number(),
  updatedAt: z.number().nullable(),
});

export const volunteerTasksResource: CrudResource<
  Awaited<ReturnType<typeof service.listTasks>>[number],
  Awaited<ReturnType<typeof service.getTaskById>>,
  z.infer<typeof createSchema>,
  z.infer<typeof updateSchema>
> = {
  capability: "volunteer",
  schemas: { create: createSchema, update: updateSchema, response: responseSchema },
  ops: {
    list: () => service.listTasks(),
    get: (id) => service.getTaskById(id),
    create: async (input, req) => {
      const { id } = await service.createTask(input, requireTenantScope(req));
      const dto = await service.getTaskById(id);
      if (!dto) throw new Error("volunteer-task: la tarea recién creada no se encontró");
      return dto;
    },
    update: (id, input) => service.updateTask(id, input),
  },
};

export const publicVolunteerTasksRouter = createCrudRouter(volunteerTasksResource);
