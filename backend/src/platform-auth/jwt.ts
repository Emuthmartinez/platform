import jwt from "jsonwebtoken";
import { env } from "@/config/env";

const AUDIENCE = "mallanet-platform-ops";
const ISSUER = "mallanet-platform-api";

export interface PlatformJwtPayload {
  sub: string;
}

export function signPlatformToken(operatorId: string): string {
  if (!env.PLATFORM_JWT_SECRET) throw new Error("PLATFORM_JWT_SECRET not configured");
  return jwt.sign({ sub: operatorId }, env.PLATFORM_JWT_SECRET, {
    algorithm: "HS256",
    audience: AUDIENCE,
    issuer: ISSUER,
    expiresIn: env.JWT_TTL_SECONDS,
  });
}

export function verifyPlatformToken(token: string): PlatformJwtPayload | null {
  if (!env.PLATFORM_JWT_SECRET) return null;
  try {
    const decoded = jwt.verify(token, env.PLATFORM_JWT_SECRET, {
      algorithms: ["HS256"],
      audience: AUDIENCE,
      issuer: ISSUER,
    });
    return typeof decoded === "object" && decoded && typeof decoded.sub === "string"
      ? { sub: decoded.sub }
      : null;
  } catch {
    return null;
  }
}
