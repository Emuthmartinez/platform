/**
 * POST /api/campaign/compromisos — una persona se compromete a llevar material
 * a un punto de recolección.
 *
 * Formulario público que escribe: rateLimit estricto + requireHuman (Turnstile)
 * + validate(zod), como el resto de formularios públicos. Si la escritura
 * falla, el compromiso se captura en failed_submissions antes de devolver el
 * 503: perder el dato de contacto de alguien que ofrece cemento es perder la
 * donación entera.
 */
import { Router } from "express";
import { z } from "zod";
import { asyncHandler, rateLimit, requireHuman, validate } from "@/middleware";
import { hashIp } from "@/lib/client-ip";
import { logDbFailure } from "@/lib/db-error";
import { captureFailedSubmission } from "@/lib/failed-submission";
import { serviceUnavailable } from "@/lib/errors";
import { CAMPAIGN_MATERIALS, MATERIAL_KEYS } from "@/lib/campaign-materials";
import { MAX_REPORT_PHOTO_CHARS } from "@/services/report-types";
import { pledges } from "@/services/campaign";
import { requireTenantScope } from "@/middleware/tenant";

export const campaignPledgesRouter = Router();

const itemSchema = z.object({
  material: z.enum(MATERIAL_KEYS),
  quantity: z.number().int().positive().max(100_000),
  unit: z.string().trim().max(40).optional().default(""),
});

const pledgeBody = z.object({
  siteId: z.string().trim().min(1).max(64).nullable().optional(),
  donorName: z.string().trim().min(1, "Escribe tu nombre.").max(120),
  donorContact: z.string().trim().min(1, "Indica tu WhatsApp o correo.").max(120),
  publicAlias: z.string().trim().max(80).optional(),
  showInWall: z.boolean().optional().default(false),
  items: z.array(itemSchema).min(1, "Indica al menos un material.").max(10),
  expectedAt: z.number().int().positive().optional(),
  note: z.string().trim().max(1000).optional().default(""),
  photo: z
    .string()
    .max(MAX_REPORT_PHOTO_CHARS, "La foto es demasiado grande.")
    .nullable()
    .optional(),
  source: z.string().trim().max(500).optional(),
  turnstileToken: z.string().optional(),
});

/**
 * @swagger
 * /api/campaign/compromisos:
 *   post:
 *     tags: [system]
 *     summary: Registra un compromiso de donación de material
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [donorName, donorContact, items]
 *             properties:
 *               siteId: { type: string, description: "Punto donde entregará" }
 *               donorName: { type: string }
 *               donorContact: { type: string, description: "WhatsApp o correo" }
 *               publicAlias: { type: string, description: "Nombre a mostrar en el muro" }
 *               showInWall: { type: boolean, description: "Consentimiento explícito de aparecer en público" }
 *               items:
 *                 type: array
 *                 items:
 *                   type: object
 *                   properties:
 *                     material: { type: string }
 *                     quantity: { type: integer }
 *     responses:
 *       200:
 *         description: Compromiso registrado, con su código de certificado
 *       400: { description: Entrada inválida }
 *       429: { description: Demasiados envíos (rate limit) }
 *       503: { description: No se pudo guardar el compromiso }
 */
campaignPledgesRouter.post(
  "/",
  rateLimit({ scope: "campaign-pledge", limit: 5 }),
  requireHuman,
  validate({ body: pledgeBody }),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof pledgeBody>;
    try {
      const pledge = await pledges.createPledge({
        siteId: body.siteId ?? null,
        donorName: body.donorName,
        donorContact: body.donorContact,
        // El muro público es opt-in explícito: sin la casilla marcada no se
        // guarda alias, así que no hay nada que publicar ni por accidente.
        publicAlias: body.showInWall ? body.publicAlias || body.donorName : null,
        items: body.items.map((item) => ({
          material: item.material,
          quantity: item.quantity,
          unit: item.unit || CAMPAIGN_MATERIALS[item.material].unit,
        })),
        expectedAt: body.expectedAt ?? null,
        note: body.note,
        photo: body.photo ?? null,
        source: body.source ?? "web",
        ipHash: hashIp(req),
      }, requireTenantScope(req));
      res.status(200).json({
        ok: true,
        code: pledge.code,
        message:
          "Compromiso registrado. Lleva este código al punto: con él se confirma tu entrega y se emite tu certificado.",
      });
    } catch (err) {
      logDbFailure("campaign.pledge", err);
      await captureFailedSubmission("campaign_pledges", body, err, req.tenantScope);
      throw serviceUnavailable("No se pudo guardar el compromiso.");
    }
  }),
);
