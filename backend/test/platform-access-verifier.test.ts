import { generateKeyPair, SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import "./helpers";
import { verifyPlatformAccessAssertionWith } from "@/platform-auth/access";

const issuer = "https://mallanet-platform.cloudflareaccess.com";
const audience = "synthetic-staging-audience";

async function assertion(overrides?: { issuer?: string; audience?: string; algorithm?: "RS256" }) {
  const { privateKey, publicKey } = await generateKeyPair(overrides?.algorithm ?? "RS256");
  const token = await new SignJWT({ email: "Operator@Test.Local" })
    .setProtectedHeader({ alg: overrides?.algorithm ?? "RS256" })
    .setSubject("stable-access-subject")
    .setIssuer(overrides?.issuer ?? issuer)
    .setAudience(overrides?.audience ?? audience)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);
  return { token, publicKey };
}

describe("Cloudflare Access assertion verification", () => {
  it("accepts only the exact issuer and environment audience", async () => {
    const valid = await assertion();
    await expect(verifyPlatformAccessAssertionWith(valid.token, {
      issuer,
      audience,
      key: valid.publicKey,
    })).resolves.toEqual({ subject: "stable-access-subject", email: "operator@test.local" });

    const wrongAudience = await assertion({ audience: "synthetic-production-audience" });
    await expect(verifyPlatformAccessAssertionWith(wrongAudience.token, {
      issuer,
      audience,
      key: wrongAudience.publicKey,
    })).resolves.toBeNull();

    const wrongIssuer = await assertion({ issuer: "https://other.cloudflareaccess.com" });
    await expect(verifyPlatformAccessAssertionWith(wrongIssuer.token, {
      issuer,
      audience,
      key: wrongIssuer.publicKey,
    })).resolves.toBeNull();
  });

  it("rejects expired assertions", async () => {
    const { privateKey, publicKey } = await generateKeyPair("RS256");
    const token = await new SignJWT({ email: "operator@test.local" })
      .setProtectedHeader({ alg: "RS256" })
      .setSubject("stable-access-subject")
      .setIssuer(issuer)
      .setAudience(audience)
      .setExpirationTime(1)
      .sign(privateKey);
    await expect(verifyPlatformAccessAssertionWith(token, {
      issuer,
      audience,
      key: publicKey,
    })).resolves.toBeNull();
  });
});
