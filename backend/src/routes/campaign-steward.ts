/**
 * /api/campaign/punto — lo que ve y hace el responsable de un punto.
 *
 * Todo va contra el punto que resuelve el token (res.locals.steward.siteId).
 * Un responsable no puede leer ni confirmar nada de otro punto, aunque mande
 * otro siteId en el cuerpo: aquí ese campo sencillamente no se lee.
 */
import { Router } from "express";
import { z } from "zod";
import { asyncHandler, rateLimit, validate } from "@/middleware";
import { requireCampaignSteward } from "@/middleware/campaign-steward";
import { badRequest } from "@/lib/errors";
import { MATERIAL_KEYS } from "@/lib/campaign-materials";
import { MAX_REPORT_PHOTO_CHARS } from "@/services/report-types";
import { receipts } from "@/services/campaign";
import { receiptMessage, type ReceiptKind } from "@/services/campaign/receipt-status";
import type { StewardIdentity } from "@/services/campaign/stewards";
import { requireTenantScope } from "@/middleware/tenant";

export const campaignStewardRouter = Router();

const receiptBody = z.object({
  pledgeCode: z.string().trim().max(20).optional(),
  items: z
    .array(
      z.object({
        material: z.enum(MATERIAL_KEYS),
        quantity: z.number().int().positive().max(100_000),
        unit: z.string().trim().max(40).optional().default(""),
      }),
    )
    .min(1, "Indica al menos un material recibido.")
    .max(10),
  note: z.string().trim().max(500).optional().default(""),
  photo: z
    .string()
    .max(MAX_REPORT_PHOTO_CHARS, "La foto es demasiado grande.")
    .nullable()
    .optional(),
});

function stewardOf(res: { locals: Record<string, unknown> }): StewardIdentity {
  return res.locals.steward as StewardIdentity;
}

/**
 * @swagger
 * /api/campaign/punto:
 *   get:
 *     tags: [system]
 *     summary: Bandeja del responsable de punto (compromisos pendientes y entregas recientes)
 *     responses:
 *       200: { description: Bandeja del punto }
 *       401: { description: Token inválido }
 */
campaignStewardRouter.get(
  "/",
  rateLimit({ scope: "campaign-steward", limit: 60 }),
  requireCampaignSteward,
  asyncHandler(async (req, res) => {
    const steward = stewardOf(res);
    const [pending, recent] = await Promise.all([
      receipts.listPendingForSite(steward.siteId),
      receipts.listRecentReceipts(steward.siteId),
    ]);
    res.json({
      site: { id: steward.siteId, name: steward.siteName, city: steward.city },
      steward: { displayName: steward.displayName },
      pending,
      recent,
    });
  }),
);

/**
 * @swagger
 * /api/campaign/punto/recepciones:
 *   post:
 *     tags: [system]
 *     summary: Confirma material recibido en el punto
 *     responses:
 *       200: { description: Recepción registrada }
 *       400: { description: Código desconocido o ya confirmado }
 *       401: { description: Token inválido }
 */
// requireCampaignSteward ES el gate de esta mutación: token opaco del
// responsable, validado por hash contra campaign_site_stewards, misma figura
// que requireSupplyWrite para el POC de hospital. La lista de la regla es fija
// y no lo incluye, así que se documenta la excepción como pide AGENTS.md.
// eslint-disable-next-line local/user-facing-mutation-needs-guard -- gate por token de responsable
campaignStewardRouter.post(
  "/recepciones",
  rateLimit({ scope: "campaign-steward-write", limit: 60 }),
  requireCampaignSteward,
  validate({ body: receiptBody }),
  asyncHandler(async (req, res) => {
    const steward = stewardOf(res);
    const body = req.body as z.infer<typeof receiptBody>;
    const outcome = await receipts.registerReceipt({
      siteId: steward.siteId,
      stewardId: steward.id,
      pledgeCode: body.pledgeCode ? body.pledgeCode.toUpperCase() : null,
      items: body.items.map((item) => ({
        material: item.material,
        quantity: item.quantity,
        unit: item.unit || "",
      })),
      note: body.note,
      photo: body.photo ?? null,
    }, requireTenantScope(req));

    if (!outcome.ok) {
      throw badRequest(
        outcome.reason === "unknown_code"
          ? "Ese código no existe. Revisa lo que trae la persona."
          : "Ese compromiso ya se confirmó antes.",
      );
    }

    res.json({
      ok: true,
      receiptId: outcome.receiptId,
      status: outcome.status,
      message: receiptMessage(outcome.status as ReceiptKind),
    });
  }),
);
