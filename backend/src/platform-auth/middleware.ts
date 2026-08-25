import type { Request, RequestHandler } from "express";
import { env } from "@/config/env";
import { unauthorized } from "@/lib/errors";
import { verifyPlatformToken } from "@/platform-auth/jwt";
import { loadPlatformOperator, type PlatformOperator } from "@/platform-auth/service";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      platformOperator?: PlatformOperator;
    }
  }
}

function extractPlatformToken(req: Request): string | null {
  const auth = req.headers.authorization;
  if (auth?.startsWith("Bearer ")) return auth.slice(7).trim() || null;
  const cookies = (req as Request & { cookies?: Record<string, string> }).cookies;
  return cookies?.[env.PLATFORM_AUTH_COOKIE_NAME] || null;
}

export const requirePlatformOperator: RequestHandler = (req, _res, next) => {
  const token = extractPlatformToken(req);
  const payload = token ? verifyPlatformToken(token) : null;
  if (!payload) return next(unauthorized("Platform operator authentication required."));
  loadPlatformOperator(payload.sub)
    .then((operator) => {
      if (!operator) return next(unauthorized("Platform operator session is invalid or expired."));
      req.platformOperator = operator;
      next();
    })
    .catch(next);
};
