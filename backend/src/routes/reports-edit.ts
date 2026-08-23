import type { Router } from "express";
import { z } from "zod";
import { asyncHandler, rateLimit, requireHuman, validate } from "@/middleware";
import { forbidden, notFound, serviceUnavailable } from "@/lib/errors";
import { reportEditTokenMatches } from "@/lib/report-edit-token";
import * as service from "@/services/reports";
import { requireTenantScope } from "@/middleware/tenant";

const idParam = z.object({ id: z.string().min(1, "Falta el id") });

const editBody = z.object({
  editToken: z.string().trim().min(16, "Falta el código de edición."),
  lat: z.coerce.number().finite().min(-90).max(90).optional(),
  lng: z.coerce.number().finite().min(-180).max(180).optional(),
  place: z.string().trim().min(1).max(200).optional(),
  affected: z.union([z.number(), z.string()]).optional(),
  needs: z.string().max(1000).optional(),
  turnstileToken: z.string().optional(),
});

export function registerReportEdit(router: Router): void {
  router.patch(
    "/:id",
    rateLimit({ scope: "reports:edit", limit: 20 }),
    requireHuman,
    validate({ params: idParam, body: editBody }),
    asyncHandler(async (req, res) => {
      const { id } = req.params as z.infer<typeof idParam>;
      const body = req.body as z.infer<typeof editBody>;
      const current = await service.getReportById(id);
      if (!current) throw notFound("No encontrado");
      if (!reportEditTokenMatches(id, body.editToken)) {
        throw forbidden("El código de edición no es válido.");
      }
      try {
        const report = await service.updateReport(id, {
          lat: body.lat,
          lng: body.lng,
          place: body.place,
          affected: body.affected !== undefined ? Number(body.affected) || 0 : undefined,
          needs: body.needs,
        }, requireTenantScope(req));
        res.json({ report });
      } catch (err) {
        throw serviceUnavailable(
          err instanceof Error ? err.message : "No se pudo guardar el cambio.",
        );
      }
    }),
  );
}
