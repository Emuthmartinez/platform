/**
 * Middleware compartido. El objetivo: que cada endpoint declare sus protecciones
 * en 1-2 líneas y NO repita lógica de auth/rate-limit/captcha/validación.
 *
 * Uso típico de una mutación pública:
 *   router.post("/",
 *     rateLimit({ scope: "missing:create", limit: 10 }),
 *     requireHuman,                       // Cloudflare Turnstile
 *     validate({ body: createMissingSchema }),
 *     asyncHandler(createMissing),
 *   )
 *
 * Mutación admin:
 *   router.delete("/:id", requireAdmin, asyncHandler(deleteMissing))
 */
import type { Request, Response, NextFunction, RequestHandler } from "express";
import type { ZodType } from "zod";
import { checkRateLimit } from "@/lib/rate-limit";
import { verifyTurnstile } from "@/lib/turnstile";
import { hashIp } from "@/lib/client-ip";
import { HttpError, tooManyRequests, badRequest, unauthorized, forbidden } from "@/lib/errors";
import { env } from "@/config/env";
import { timingSafeEqual } from "crypto";
import { requestId } from "@/lib/request-context";
import { tenantRateLimitPartition } from "@/tenant/scope";

/** Envuelve un handler async para que los throws lleguen al errorHandler. */
export function asyncHandler(
  fn: (req: Request, res: Response) => Promise<void> | void,
): RequestHandler {
  return (req, res, next) => Promise.resolve(fn(req, res)).catch(next);
}

/**
 * Cabeceras para servir una FOTO pública (bytes de imagen inmutables).
 *
 * ACAO fijo en `*` en vez del reflejo por-Origin del middleware cors():
 * estas respuestas se cachean en el borde de Cloudflare, que IGNORA `Vary`.
 * Con el reflejo, la copia cacheada llevaría el ACAO (o la ausencia de ACAO)
 * de quien pidió primero, y el fetch en modo CORS del service worker fallaría
 * al azar según qué copia tocó. Una imagen pública sin credenciales es el caso
 * exacto para el comodín; se retira Allow-Credentials porque `*` + credenciales
 * es una combinación inválida para el navegador (y nadie pide fotos con
 * cookies: los <img> y el SW van sin credenciales).
 */
export function setPublicPhotoHeaders(res: Response, contentType: string): void {
  res.setHeader("Content-Type", contentType);
  res.setHeader(
    "Cache-Control",
    "public, max-age=31536000, s-maxage=31536000, immutable",
  );
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.removeHeader("Access-Control-Allow-Credentials");
  res.removeHeader("Vary");
}

/** Rate-limit por IP (cf-connecting-ip) + scope. Valkey-backed, fail-open. */
export function rateLimit(opts: { scope: string; limit: number; windowMs?: number }): RequestHandler {
  return (req, _res, next) => {
    const ip = hashIp(req);
    const key = `rl:${opts.scope}:${tenantRateLimitPartition(req.tenantScope)}:${ip}`;
    checkRateLimit(key, { limit: opts.limit, windowMs: opts.windowMs }, `flood:${ip}`)
      .then((ok) => {
        if (!ok) throw tooManyRequests("Vas muy rápido. Espera un momento e inténtalo de nuevo.");
        next();
      })
      .catch(next);
  };
}

/** Prueba de humanidad: Cloudflare Turnstile. Bloquea bots en writes públicos. */
export const requireHuman: RequestHandler = (req, _res, next) => {
  verifyTurnstile(req)
    .then((human) => {
      if (!human) throw forbidden("Verificación anti-bot fallida. Recarga e inténtalo de nuevo.");
      next();
    })
    .catch(next);
};

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** Auth de admin (x-admin-token == ADMIN_PASSWORD), comparación constante. */
export const requireAdmin: RequestHandler = (req, _res, next) => {
  const expected = env.ADMIN_PASSWORD;
  const got = req.headers["x-admin-token"];
  if (!expected || typeof got !== "string" || !safeEqual(got, expected)) {
    return next(unauthorized("Se requiere token de administrador."));
  }
  next();
};

/** Auth de cron (Authorization: Bearer CRON_SECRET) o admin. */
export const requireCron: RequestHandler = (req, _res, next) => {
  const secret = env.CRON_SECRET;
  const auth = req.headers.authorization;
  if (secret && auth && safeEqual(auth, `Bearer ${secret}`)) return next();
  // un admin también puede dispararlo
  const expected = env.ADMIN_PASSWORD;
  const got = req.headers["x-admin-token"];
  if (expected && typeof got === "string" && safeEqual(got, expected)) return next();
  next(unauthorized("Se requiere secreto de cron o token de administrador."));
};

/**
 * Validación zod de body/query/params. Reemplaza los datos por los parseados.
 *
 * OJO Express 5: `req.query` ya no es una propiedad, es un getter del prototipo
 * que re-parsea la URL en CADA acceso y devuelve un objeto NUEVO. Mutar ese
 * objeto (Object.assign) se descarta antes de llegar al handler, y los
 * .default()/.coerce de zod se pierden — así fue el `LIMIT NaN` → 500 de
 * /api/patients/search sin ?limit. La salida parseada se fija como propiedad
 * PROPIA del request (sombrea el getter), de modo que el handler lee exactamente
 * lo validado. Efecto deliberado: las claves de query fuera del esquema dejan
 * de llegar al handler (zod las descarta al parsear).
 *
 * `req.params` sí es una propiedad de datos estable dentro del route layer,
 * pero se fija igual (propiedad propia, mezclando sobre los params originales
 * para no perder claves de ruta fuera del esquema) para no depender de ese
 * detalle interno del router — la misma suposición que ya se rompió con query.
 */
export function validate(schemas: {
  body?: ZodType;
  query?: ZodType;
  params?: ZodType;
}): RequestHandler {
  const ownProperty = (value: unknown): PropertyDescriptor => ({
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
  return (req, _res, next) => {
    try {
      if (schemas.body) req.body = schemas.body.parse(req.body);
      if (schemas.query) {
        Object.defineProperty(req, "query", ownProperty(schemas.query.parse(req.query)));
      }
      if (schemas.params) {
        const parsed = schemas.params.parse(req.params) as Record<string, unknown>;
        Object.defineProperty(req, "params", ownProperty({ ...req.params, ...parsed }));
      }
      next();
    } catch (e) {
      const msg = e instanceof Error && "issues" in e
        ? (e as { issues: { message: string }[] }).issues.map((i) => i.message).join("; ")
        : "Datos inválidos.";
      next(badRequest(msg));
    }
  };
}

/** Error handler central: traduce HttpError (y desconocidos) a JSON { error }. */
export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  if (err instanceof HttpError) {
    if (err.headers) for (const [k, v] of Object.entries(err.headers)) res.setHeader(k, v);
    res.status(err.status).json({ error: err.message });
    return;
  }
  // No filtrar detalles internos al cliente.
  console.error(
    JSON.stringify({
      t: "unhandled_error",
      request_id: requestId(req),
      error_name: err instanceof Error ? err.name : typeof err,
    }),
  );
  res.status(500).json({
    error: "Error interno del servidor.",
    requestId: requestId(req),
  });
}
