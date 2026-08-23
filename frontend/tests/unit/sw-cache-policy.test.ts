import { describe, expect, it } from "vitest";
import {
  buildSwConfig,
  isAnonymousPublicJsonPath,
  hasPrivilegedHeaderValue,
  shouldDeleteOwnedCache,
  swKeepCacheNames,
  SW_OWNED_CACHE_PREFIX,
} from "@/lib/sw-cache-policy";

describe("service-worker cache policy", () => {
  it("names caches with epoch, org, and incident, and keeps v9", () => {
    const config = buildSwConfig("abc123def");
    expect(config.cacheNames.api).toContain("mallanet-e0-");
    expect(config.cacheNames.api).toContain("org_mallanet");
    expect(config.cacheNames.photos).toContain("inc_terremoto_colombia_2026");
    expect(config.buildSha).toBe("abc123def");
    expect(config.previousCacheNames).toContain("static-v9");
    expect(config.previousCacheNames).toContain("photos-v9");
    const keep = swKeepCacheNames(config);
    expect(keep.has("static-v9")).toBe(true);
    expect(keep.has(config.cacheNames.static)).toBe(true);
  });

  it("deletes only owned prefix names that are not kept", () => {
    const config = buildSwConfig();
    const keep = swKeepCacheNames(config);
    expect(
      shouldDeleteOwnedCache(config.cacheNames.api, keep, SW_OWNED_CACHE_PREFIX),
    ).toBe(false);
    expect(
      shouldDeleteOwnedCache(
        "mallanet-e0-stale-api",
        keep,
        SW_OWNED_CACHE_PREFIX,
      ),
    ).toBe(true);
    expect(shouldDeleteOwnedCache("static-v9", keep, SW_OWNED_CACHE_PREFIX)).toBe(
      false,
    );
    expect(
      shouldDeleteOwnedCache("other-app-cache", keep, SW_OWNED_CACHE_PREFIX),
    ).toBe(false);
  });

  it("allowlists anonymous public JSON and denies chat, patients, photos, cookies", () => {
    expect(isAnonymousPublicJsonPath("/api/missing")).toBe(true);
    expect(isAnonymousPublicJsonPath("/api/reports")).toBe(true);
    expect(isAnonymousPublicJsonPath("/api/chat")).toBe(false);
    expect(isAnonymousPublicJsonPath("/api/hospitals/h1/patients")).toBe(false);
    expect(isAnonymousPublicJsonPath("/api/missing/id/photo")).toBe(false);
    expect(
      hasPrivilegedHeaderValue((name) =>
        name === "cookie" ? "session=demo" : null,
      ),
    ).toBe(true);
    expect(hasPrivilegedHeaderValue(() => null)).toBe(false);
  });
});
