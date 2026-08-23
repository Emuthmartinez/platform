/**
 * Router `api/public/psychology` — portal exclusivo de psicólogos.
 *
 * Una sola ruta GET gateada por `psychology:access` (deny-by-default): es la
 * prueba de acceso del portal /psicologia y devuelve el perfil mínimo +
 * `resources` (vacío hasta que el mantenedor entregue el contenido real:
 * protocolos, casos, guardias). No es CRUD de modelo, por eso router a mano.
 *
 * La respuesta es POR-USUARIO: Cache-Control no-store (mismo criterio que
 * auth/me — nunca cacheable en un proxy compartido).
 */
import { Router } from "express";
import { asyncHandler, rateLimit } from "@/middleware";
import { requireCapability } from "@/middleware/auth";
import { serviceUnavailable } from "@/lib/errors";
import { expectedFormTokens } from "@/services/psychology-help";
import { publicApiOrigin } from "@/middleware/tenant";

export const psychologyRouter = Router();

/**
 * @swagger
 * /api/public/psychology:
 *   get:
 *     summary: Acceso al portal de psicólogos (capability psychology:access)
 *     tags: [Psychology]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Acceso concedido; perfil + recursos del portal }
 *       401: { description: No autenticado }
 *       403: { description: Sin la capacidad psychology:access }
 */
psychologyRouter.get(
  "/",
  rateLimit({ scope: "psychology", limit: 60 }),
  requireCapability("psychology:access"),
  asyncHandler(async (req, res) => {
    res.set("Cache-Control", "no-store");
    res.json({
      ok: true,
      user: { id: req.user!.id, email: req.user!.email },
      resources: [],
    });
  }),
);

/**
 * @swagger
 * /api/public/psychology/form-callback:
 *   get:
 *     summary: Apps Script listo para pegar en el Google Forms (token embebido)
 *     tags: [Psychology]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Script + URL del callback + token }
 *       403: { description: Sin la capacidad psychology:access }
 *       503: { description: No hay secreto base para derivar el token }
 */
psychologyRouter.get(
  "/form-callback",
  rateLimit({ scope: "psychology:form-callback", limit: 30 }),
  requireCapability("psychology:access"),
  asyncHandler(async (req, res) => {
    // El token derivado del JWT_SECRET es el último de la lista (el override
    // explícito, si existe, va primero y es el que manda).
    const [token] = expectedFormTokens();
    if (!token) {
      throw serviceUnavailable("No hay secreto base para derivar el token del callback.");
    }
    const url = `${publicApiOrigin(req)}/api/stats/psychology-help`;
    const script = [
      "function onFormSubmit() {",
      `  UrlFetchApp.fetch("${url}", {`,
      '    method: "post",',
      '    contentType: "application/json",',
      `    payload: JSON.stringify({ source: "form", token: "${token}" }),`,
      "    muteHttpExceptions: true,",
      "  });",
      "}",
    ].join("\n");
    res.set("Cache-Control", "no-store");
    res.json({ url, token, script });
  }),
);
