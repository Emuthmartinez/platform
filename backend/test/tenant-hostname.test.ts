import { describe, expect, it } from "vitest";
import {
  TRUSTED_HOSTNAME_HEADER,
  canonicalizeHostname,
  developmentPinMissing,
  isTenantExemptPath,
  overwriteTrustedHostnameHeader,
  unknownHostPayload,
} from "@/tenant/hostname";
import {
  createTenantScope,
  tenantCachePartition,
  tenantRateLimitPartition,
} from "@/tenant/scope";

describe("canonicalizeHostname", () => {
  it("lowercases and strips a trailing dot", () => {
    expect(canonicalizeHostname("API-Staging.TerremotoColombia.co.")).toBe(
      "api-staging.terremotocolombia.co",
    );
  });

  it("rejects ports, commas, spaces, and empty values", () => {
    expect(canonicalizeHostname("localhost:8080")).toBeNull();
    expect(canonicalizeHostname("a.example.org,b.example.org")).toBeNull();
    expect(canonicalizeHostname(" a.example.org")).toBe("a.example.org");
    expect(canonicalizeHostname("")).toBeNull();
    expect(canonicalizeHostname(undefined)).toBeNull();
  });
});

describe("overwriteTrustedHostnameHeader", () => {
  it("replaces a client-supplied internal carrier with the URL hostname", () => {
    const { headers, canonical } = overwriteTrustedHostnameHeader(
      new Request("https://api-staging.terremotocolombia.co/api/reports", {
        headers: {
          [TRUSTED_HOSTNAME_HEADER]: "other.example.org",
          "x-forwarded-host": "evil.example.org",
        },
      }),
    );
    expect(canonical).toBe("api-staging.terremotocolombia.co");
    expect(headers.get(TRUSTED_HOSTNAME_HEADER)).toBe(
      "api-staging.terremotocolombia.co",
    );
  });
});

describe("tenant path exemptions and pins", () => {
  it("exempts only healthz and readyz", () => {
    expect(isTenantExemptPath("/api/healthz")).toBe(true);
    expect(isTenantExemptPath("/api/readyz/")).toBe(true);
    expect(isTenantExemptPath("/api/reports")).toBe(false);
    expect(isTenantExemptPath("/api/health")).toBe(false);
  });

  it("fails the development pin at boot, not per request", () => {
    expect(developmentPinMissing("development", undefined)).toBe(true);
    expect(developmentPinMissing("development", "  ")).toBe(true);
    expect(developmentPinMissing("development", "localhost")).toBe(false);
    expect(developmentPinMissing("production", undefined)).toBe(false);
    expect(developmentPinMissing("test", undefined)).toBe(false);
  });

  it("returns the generic unknown-host body", () => {
    expect(unknownHostPayload()).toEqual({ error: "Ruta no encontrada." });
  });
});

describe("tenant cache and rate-limit partitions", () => {
  it("keeps two incidents from sharing a Valkey or cache key", () => {
    const a = createTenantScope({
      organizationId: "org_mallanet",
      incidentId: "inc_one",
      hostname: "one.example.org",
    });
    const b = createTenantScope({
      organizationId: "org_mallanet",
      incidentId: "inc_two",
      hostname: "two.example.org",
    });
    expect(tenantRateLimitPartition(a)).not.toBe(tenantRateLimitPartition(b));
    expect(tenantCachePartition(a)).not.toBe(tenantCachePartition(b));
    expect(`rl:reports:${tenantRateLimitPartition(a)}:ip`).not.toBe(
      `rl:reports:${tenantRateLimitPartition(b)}:ip`,
    );
  });
});
