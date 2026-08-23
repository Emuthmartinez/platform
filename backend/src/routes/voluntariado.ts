import { Router } from "express";
import express from "express";
import { z } from "zod";
import { asyncHandler, rateLimit, requireHuman, validate } from "@/middleware";
import { badRequest, notFound, payloadTooLarge } from "@/lib/errors";
import * as service from "@/services/volunteer-tasks";
import * as checkins from "@/services/volunteer-checkins";
import { getVolunteerByCode } from "@/services/volunteers";
import { isValidPhotoDataUrl, MAX_REPORT_PHOTO_CHARS } from "@/services/reports";
import { requireTenantScope } from "@/middleware/tenant";

export const voluntariadoRouter = Router();

const respondBody = z.object({
  action: z.enum(["aceptar", "rechazar", "terminar"]),
});

const codeField = z.string().trim().min(4).max(12);

const verifyBody = z.object({
  code: codeField,
  turnstileToken: z.string().optional(),
});

const checkinBody = z.object({
  code: codeField,
  place: z
    .string()
    .trim()
    .min(1, "Indica el lugar (centro de acopio, punto de entrega).")
    .max(200),
  note: z.string().trim().max(1000, "La nota no puede pasar de 1000 caracteres.").optional().default(""),
  photo: z.string().max(MAX_REPORT_PHOTO_CHARS, "La foto es demasiado grande.").nullable().optional(),
  availability: z.string().trim().max(80).optional(),
  talent: z.string().trim().max(120).optional(),
  area: z.string().trim().max(200).optional(),
  turnstileToken: z.string().optional(),
});

const jsonPhoto = express.json({ limit: "2mb" });

voluntariadoRouter.post(
  "/verificar-codigo",
  rateLimit({ scope: "voluntariado:verify", limit: 10 }),
  requireHuman,
  validate({ body: verifyBody }),
  asyncHandler(async (req, res) => {
    const { code } = req.body as z.infer<typeof verifyBody>;
    const volunteer = await getVolunteerByCode(code);
    if (!volunteer) throw notFound("El código no es válido. Revísalo e inténtalo de nuevo.");
    res.json({ ok: true, name: volunteer.name });
  }),
);

voluntariadoRouter.post(
  "/checkin",
  jsonPhoto,
  rateLimit({ scope: "voluntariado:checkin", limit: 10 }),
  requireHuman,
  validate({ body: checkinBody }),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof checkinBody>;
    if (body.photo) {
      if (!isValidPhotoDataUrl(body.photo)) {
        throw badRequest("La foto debe ser una imagen JPG, PNG o WebP válida.");
      }
      if (body.photo.length > MAX_REPORT_PHOTO_CHARS) {
        throw payloadTooLarge("La foto es demasiado grande. Usa una imagen más liviana.");
      }
    }
    const created = await checkins.createVolunteerCheckin({
      code: body.code,
      place: body.place,
      note: body.note,
      photo: body.photo ?? null,
      availability: body.availability,
      talent: body.talent,
      area: body.area,
    }, requireTenantScope(req));
    if (!created) {
      throw badRequest("El código no es válido. Revísalo e inténtalo de nuevo.");
    }
    res.status(201).json({ ok: true, id: created.id });
  }),
);

const ACTION_MAP = {
  aceptar: "accept",
  rechazar: "decline",
  terminar: "done",
} as const;

voluntariadoRouter.get(
  "/:token",
  rateLimit({ scope: "voluntariado:read", limit: 30 }),
  asyncHandler(async (req, res) => {
    const token = (req.params as { token: string }).token;
    const assignment = await service.getAssignmentByToken(token);
    if (!assignment) throw notFound("Este enlace no es válido o ya no está vigente.");
    res.set("Cache-Control", "no-store");
    res.json(assignment);
  }),
);

// eslint-disable-next-line local/user-facing-mutation-needs-guard -- token del correo es la credencial; rateLimit anti-fuerza-bruta
voluntariadoRouter.post(
  "/:token/responder",
  rateLimit({ scope: "voluntariado:respond", limit: 10 }),
  validate({ body: respondBody }),
  asyncHandler(async (req, res) => {
    const token = (req.params as { token: string }).token;
    const { action } = req.body as z.infer<typeof respondBody>;
    const result = await service.respondToAssignment(token, ACTION_MAP[action]);
    if (!result) {
      throw notFound("Este enlace no es válido o la acción no aplica al estado actual.");
    }
    res.json({ ok: true, ...result });
  }),
);
