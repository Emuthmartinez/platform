import { createRemoteJWKSet, jwtVerify } from "jose";
import { env } from "@/config/env";

export interface PlatformAccessIdentity {
  subject: string;
  email: string;
}

type AccessVerificationKey = Parameters<typeof jwtVerify>[1];

export async function verifyPlatformAccessAssertionWith(
  assertion: string,
  input: { issuer: string; audience: string; key: AccessVerificationKey },
): Promise<PlatformAccessIdentity | null> {
  try {
    const { payload } = await jwtVerify(assertion, input.key, {
      issuer: input.issuer,
      audience: input.audience,
      algorithms: ["RS256"],
    });
    if (typeof payload.sub !== "string" || typeof payload.email !== "string") return null;
    return { subject: payload.sub, email: payload.email.trim().toLowerCase() };
  } catch {
    return null;
  }
}

export async function verifyPlatformAccessAssertion(
  assertion: string,
): Promise<PlatformAccessIdentity | null> {
  if (!env.PLATFORM_ACCESS_TEAM_DOMAIN || !env.PLATFORM_ACCESS_AUD) return null;
  const issuer = `https://${env.PLATFORM_ACCESS_TEAM_DOMAIN}`;
  const jwks = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
  return verifyPlatformAccessAssertionWith(assertion, {
    issuer,
    audience: env.PLATFORM_ACCESS_AUD,
    key: jwks,
  });
}
