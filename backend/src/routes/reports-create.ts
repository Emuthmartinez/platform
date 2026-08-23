import type { Router } from "express";
import express from "express";
import { z } from "zod";
import { asyncHandler, rateLimit, requireHuman, validate } from "@/middleware";
import { logDbFailure } from "@/lib/db-error";
import { captureFailedSubmission } from "@/lib/failed-submission";
import { badRequest, payloadTooLarge, serviceUnavailable } from "@/lib/errors";
import * as service from "@/services/reports";
import { requireTenantScope } from "@/middleware/tenant";
import { issueReportEditToken } from "@/lib/report-edit-token";
import { getVolunteerByCode } from "@/services/volunteers";
import { publishNeedAtLocation } from "@/modules/needs";
import type { TenantScope } from "@/tenant/scope";

const createBody = z.object({
  type: z.enum(service.REPORT_TYPE_KEYS, {
    errorMap: () => ({ message: "Selecciona el tipo de marcador." }),
  }),
  lat: z.coerce.number().finite().min(-90).max(90),
  lng: z.coerce.number().finite().min(-180).max(180),
  place: z.string().trim().min(1, "Indica el nombre o dirección del lugar.").max(200),
  affected: z.union([z.number(), z.string()]).optional(),
  needs: z.string().max(1000).optional(),
  photo: z.string().max(service.MAX_REPORT_PHOTO_CHARS, "La foto es demasiado grande.").nullable().optional(),
  volunteerCode: z.string().trim().min(4).max(12).optional(),
  turnstileToken: z.string().optional(),
});

function mirrorNeedReport(
  body: z.infer<typeof createBody>,
  scope: TenantScope,
): void {
  const needsText = (typeof body.needs === "string" ? body.needs : "").trim();
  const affected = Number(body.affected) || 0;
  void publishNeedAtLocation({
    title: (needsText || `Pedido de ayuda en ${body.place}`).slice(0, 140),
    priority: "high",
    address: body.place,
    latitude: body.lat,
    longitude: body.lng,
    items: [
      {
        name: (needsText || "Ayuda varios").slice(0, 120),
        quantity: 1,
        unit: null,
        category: "other",
      },
    ],
    description:
      affected > 0
        ? `Pedido ciudadano del mapa. Personas (estimado): ${affected}.`
        : "Pedido ciudadano del mapa.",
  }, scope);
}

export function registerReportCreate(router: Router): void {
  router.post(
    "/",
    express.json({ limit: "2mb" }),
    rateLimit({ scope: "reports:create", limit: 20 }),
    requireHuman,
    validate({ body: createBody }),
    asyncHandler(async (req, res) => {
      const body = req.body as z.infer<typeof createBody>;
      if (body.photo) {
        if (!service.isValidPhotoDataUrl(body.photo)) {
          throw badRequest("La foto debe ser una imagen JPG, PNG o WebP válida.");
        }
        if (body.photo.length > service.MAX_REPORT_PHOTO_CHARS) {
          throw payloadTooLarge("La foto es demasiado grande. Usa una imagen más liviana.");
        }
      }
      let volunteerId: string | null = null;
      if (body.volunteerCode) {
        const volunteer = await getVolunteerByCode(body.volunteerCode);
        if (!volunteer) {
          throw badRequest(
            "El código de voluntario no es válido. Revísalo o déjalo vacío.",
          );
        }
        volunteerId = volunteer.id;
      }
      try {
        const scope = requireTenantScope(req);
        const report = await service.addReport({
          type: body.type as service.ReportType,
          lat: body.lat,
          lng: body.lng,
          place: body.place,
          affected: Number(body.affected) || 0,
          needs: typeof body.needs === "string" ? body.needs : "",
          photo: body.photo ?? null,
          volunteerId,
        }, scope);
        res.status(201).json({
          report,
          editToken: issueReportEditToken(report.id),
        });
        if (body.type === "need") mirrorNeedReport(body, scope);
      } catch (err) {
        logDbFailure("reports.create", err);
        await captureFailedSubmission("reports", body, err, req.tenantScope);
        throw serviceUnavailable(
          "No se pudo guardar el reporte. Revisa tu conexión e inténtalo de nuevo.",
        );
      }
    }),
  );
}
