import { describe, expect, it } from "vitest";
import jwt from "jsonwebtoken";
import "./helpers";

process.env.PLATFORM_JWT_SECRET ??= "test-platform-jwt-secret-not-for-prod-0123456789";

describe("U30/U32 platform token audience isolation", () => {
  it("never accepts a tenant-admin JWT as a platform-operator JWT", async () => {
    const { signToken } = await import("@/auth/jwt");
    const { verifyPlatformToken } = await import("@/platform-auth/jwt");

    expect(verifyPlatformToken(signToken("tenant-user"))).toBeNull();
  });

  it("never accepts a platform-operator JWT as a tenant-admin JWT", async () => {
    const { verifyToken } = await import("@/auth/jwt");
    const { signPlatformToken } = await import("@/platform-auth/jwt");

    expect(verifyToken(signPlatformToken("platform-operator"))).toBeNull();
  });

  it("accepts only a token with the platform audience and issuer", async () => {
    const { signPlatformToken, verifyPlatformToken } = await import("@/platform-auth/jwt");
    const token = signPlatformToken("platform-operator");

    expect(verifyPlatformToken(token)).toEqual({ sub: "platform-operator" });
  });

  it("accepts a signed legacy tenant token but rejects tokens with a foreign audience", async () => {
    const { env } = await import("@/config/env");
    const { verifyToken } = await import("@/auth/jwt");
    const legacy = jwt.sign({ sub: "legacy-tenant" }, env.JWT_SECRET, {
      algorithm: "HS256",
      expiresIn: 60,
    });
    const foreign = jwt.sign({ sub: "foreign" }, env.JWT_SECRET, {
      algorithm: "HS256",
      audience: "mallanet-platform-ops",
      issuer: "mallanet-platform-api",
      expiresIn: 60,
    });

    expect(verifyToken(legacy)).toEqual({ sub: "legacy-tenant" });
    expect(verifyToken(foreign)).toBeNull();
  });
});
