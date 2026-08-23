import { Router } from "express";
import { z } from "zod";
import { asyncHandler, rateLimit, requireAdmin, setPublicPhotoHeaders, validate } from "@/middleware";
import { jsonWithEtag } from "@/lib/http";
import { hashIp } from "@/lib/client-ip";
import { HttpError, notFound, serviceUnavailable } from "@/lib/errors";
import * as service from "@/services/reports";
import { requireTenantScope } from "@/middleware/tenant";
import { registerReportCreate } from "@/routes/reports-create";
import { registerReportEdit } from "@/routes/reports-edit";

export const reportsRouter = Router();

const LIST_CACHE = {
  "Cache-Control": `public, max-age=0, s-maxage=${service.REPORT_LIST_CACHE_SECONDS}, stale-while-revalidate=30`,
};

const idParam = z.object({ id: z.string().min(1, "Falta el id") });
const listQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce
    .number()
    .int()
    .min(1)
    .max(service.MAX_REPORT_PAGE_SIZE)
    .default(service.DEFAULT_REPORT_PAGE_SIZE),
});

reportsRouter.get(
  "/",
  rateLimit({ scope: "reports:list", limit: 120 }),
  validate({ query: listQuery }),
  asyncHandler(async (req, res) => {
    const { page, pageSize } = req.query as unknown as z.infer<typeof listQuery>;
    const result = await service.listReportsPage(page, pageSize);
    jsonWithEtag(req, res, { ...result, persistent: service.isPersistent() }, LIST_CACHE);
  }),
);

registerReportCreate(reportsRouter);
registerReportEdit(reportsRouter);

reportsRouter.get(
  "/:id",
  rateLimit({ scope: "reports:detail", limit: 120 }),
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const { id } = req.params as z.infer<typeof idParam>;
    const report = await service.getReportById(id);
    if (!report) throw notFound("No encontrado");
    jsonWithEtag(req, res, { report }, LIST_CACHE);
  }),
);

reportsRouter.delete(
  "/:id",
  requireAdmin,
  rateLimit({ scope: "reports:delete", limit: 60 }),
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const { id } = req.params as z.infer<typeof idParam>;
    const removed = await service.removeReport(
      id,
      requireTenantScope(req),
    );
    if (!removed) throw notFound("No encontrado");
    res.json({ ok: true });
  }),
);

// eslint-disable-next-line local/user-facing-mutation-needs-guard -- confirmación anónima: rateLimit + hashIp
reportsRouter.post(
  "/:id/confirm",
  rateLimit({ scope: "reports:confirm", limit: 60 }),
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const { id } = req.params as z.infer<typeof idParam>;
    try {
      const result = await service.confirmReport(
        id,
        hashIp(req),
        requireTenantScope(req),
      );
      if (result.status === "not-found") throw notFound("No encontrado");
      if (result.status === "duplicate") {
        res.status(409).json({ ok: false, error: "Ya confirmaste este reporte." });
        return;
      }
      res.json({ ok: true, confirmations: result.confirmations });
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw serviceUnavailable("No se pudo confirmar. Intenta de nuevo.");
    }
  }),
);

reportsRouter.get(
  "/:id/photo",
  rateLimit({ scope: "reports:photo", limit: 240 }),
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const { id } = req.params as z.infer<typeof idParam>;
    const photo = await service.getReportPhoto(id);
    if (!photo) {
      res.status(404).type("text/plain").send("No encontrada");
      return;
    }
    if ("redirectTo" in photo) {
      res.redirect(302, photo.redirectTo);
      return;
    }
    setPublicPhotoHeaders(res, photo.contentType);
    res.send(photo.buffer);
  }),
);
