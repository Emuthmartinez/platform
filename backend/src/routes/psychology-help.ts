/**
 * /api/stats/psychology-help — contador de clics en "ayuda psicológica".
 *
 * GET público (cacheado, ETag). POST público → rateLimit (sin Turnstile: es un
 * clic de baja sensibilidad, el dedup por IP ya limita el inflado). El dedup
 * persiste el HASH de IP (hashIp), nunca la IP cruda (la columna es ip_hash).
 *
 * El route Next previo usaba clientIp() crudo como clave de dedup; aquí lo
 * hasheamos (hashIp) para no persistir IPs en claro (contexto humanitario).
 * Contrato de salida { count } IDÉNTICO.
 */
import { timingSafeEqual } from "crypto";
import { Router } from "express";
import { z } from "zod";
import { asyncHandler, rateLimit, validate } from "@/middleware";
import { jsonWithEtag } from "@/lib/http";
import { hashIp } from "@/lib/client-ip";
import { logDbFailure } from "@/lib/db-error";
import { forbidden, serviceUnavailable } from "@/lib/errors";
import * as service from "@/services/psychology-help";
import { requireTenantScope } from "@/middleware/tenant";

export const psychologyHelpRouter = Router();

// Body opcional del POST: el callback del Apps Script de Google Forms manda
// source:"form" + token (secreto compartido). Vacío = clic anónimo (dedup IP).
const clickBodyInner = z.object({
  source: z.literal("form").optional(),
  token: z.string().max(200).optional(),
});
const clickBody = clickBodyInner.optional();

function isValidFormToken(token: string | undefined): boolean {
  if (!token) return false;
  const a = Buffer.from(token);
  return service.expectedFormTokens().some((expected) => {
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
  });
}

const CACHE_HEADERS = {
  "Cache-Control": "public, max-age=0, s-maxage=5, stale-while-revalidate=30",
};

/**
 * @swagger
 * /api/stats/psychology-help:
 *   get:
 *     tags: [system]
 *     summary: Devuelve el contador de clics en "ayuda psicológica"
 *     responses:
 *       200:
 *         description: Contador actual de clics
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 count:
 *                   type: integer
 *   post:
 *     tags: [system]
 *     summary: Clic anónimo (dedup por IP) o envío de formulario (source=form + token)
 *     responses:
 *       200:
 *         description: Registro aplicado, devuelve el nuevo contador
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 count:
 *                   type: integer
 *       403:
 *         description: Callback de formulario con token inválido
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 *       429:
 *         description: Demasiadas peticiones
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 *       503:
 *         description: No se pudo registrar el clic
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 */
psychologyHelpRouter.get(
  "/",
  rateLimit({ scope: "psychology-help:list", limit: 120 }),
  asyncHandler(async (req, res) => {
    try {
      const count = await service.getPsychologyHelpClickCount();
      jsonWithEtag(req, res, { count }, CACHE_HEADERS);
    } catch (err) {
      logDbFailure("psychology-help.count", err);
      throw serviceUnavailable("No se pudo consultar el contador.");
    }
  }),
);

// eslint-disable-next-line local/user-facing-mutation-needs-guard -- contador público y anónimo; el camino formulario va autenticado por secreto compartido (Apps Script) y el anónimo por rateLimit + dedup de hash de IP, sin humano ni gate por diseño
psychologyHelpRouter.post(
  "/",
  rateLimit({ scope: "psychology-help:click", limit: 20 }),
  validate({ body: clickBody }),
  asyncHandler(async (req, res) => {
    const body = (req.body ?? {}) as z.infer<typeof clickBodyInner>;
    try {
      if (body.source === "form") {
        if (!isValidFormToken(body.token)) {
          throw forbidden("Callback de formulario no autorizado.");
        }
        const count = await service.incrementPsychologyHelpFromForm(requireTenantScope(req));
        res.status(200).json({ count });
        return;
      }
      const count = await service.incrementPsychologyHelpClick(
        hashIp(req),
        requireTenantScope(req),
      );
      res.status(200).json({ count });
    } catch (err) {
      // Un HttpError deliberado (el 403 del callback de formulario) sale tal
      // cual: no es un fallo de base y no debe degradarse a 503 ni ensuciar el
      // log de fallos de base.
      if (err instanceof Error && "status" in err) throw err;
      logDbFailure("psychology-help.click", err);
      throw serviceUnavailable("No se pudo registrar el clic.");
    }
  }),
);
