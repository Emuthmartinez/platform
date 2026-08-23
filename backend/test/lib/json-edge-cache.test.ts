import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isCacheablePublicJsonPath,
  servePublicJsonCached,
} from "@/lib/json-edge-cache";
import type { EdgeCache } from "@/lib/photo-edge-cache";
import { createTenantScope } from "@/tenant/scope";

afterEach(() => {
  vi.restoreAllMocks();
});

const TENANT = createTenantScope({
  organizationId: "org_mallanet",
  incidentId: "inc_terremoto_colombia_2026",
  hostname: "api.example.org",
});
const OTHER_TENANT = createTenantScope({
  organizationId: "org_mallanet",
  incidentId: "inc_other",
  hostname: "other.example.org",
});
const CORS = ["https://web.example.org"];

function fakeCache(initial?: Response) {
  const stored = new Map<string, Response>();
  const keys: string[] = [];
  let puts = 0;
  if (initial) stored.set("__default", initial);
  const cache: EdgeCache = {
    async match(key) {
      keys.push(key.url);
      return stored.get(key.url) ?? stored.get("__default");
    },
    async put(key, response) {
      puts++;
      stored.delete("__default");
      stored.set(key.url, response);
    },
  };
  return { cache, putCount: () => puts, keys };
}

describe("public JSON edge cache", () => {
  it("samples a bounded outcome without URL or cache-key data", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { cache } = fakeCache(
      new Response('{"cached":true}', {
        headers: {
          "Cache-Control": "public, s-maxage=5",
          "x-request-id": "stored-id",
        },
      }),
    );

    const response = await servePublicJsonCached({
      request: new Request("https://api.example.org/api/reports/private-id?contact=hidden"),
      cache,
      tenant: TENANT,
      corsOrigins: CORS,
      fetchOrigin: async () => new Response("{}"),
      waitUntil: () => {},
    });

    expect(log).toHaveBeenCalledWith({
      t: "edge_cache",
      cache: "json",
      family: "reports",
      outcome: "hit",
      status: 200,
      organization_id: TENANT.organizationId,
      incident_id: TENANT.incidentId,
      cache_epoch: TENANT.cacheEpoch,
      build: "dev",
    });
    expect(JSON.stringify(log.mock.calls)).not.toContain("private-id");
    expect(JSON.stringify(log.mock.calls)).not.toContain("contact");
    expect(response.headers.get("x-request-id")).not.toBe("stored-id");
    expect(response.headers.get("x-request-id")).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("allows hot public reads and rejects private/large binary paths", () => {
    expect(isCacheablePublicJsonPath("/api/missing/stats")).toBe(true);
    expect(isCacheablePublicJsonPath("/api/deceased")).toBe(true);
    expect(isCacheablePublicJsonPath("/api/hospitals/demo/supply")).toBe(true);
    expect(isCacheablePublicJsonPath("/api/public/users")).toBe(false);
    expect(isCacheablePublicJsonPath("/api/geocode")).toBe(false);
    expect(isCacheablePublicJsonPath("/api/missing/demo/photo")).toBe(false);
  });

  it("stores only a successful explicitly public response", async () => {
    const { cache, putCount } = fakeCache();
    const pending: Promise<unknown>[] = [];
    const response = await servePublicJsonCached({
      request: new Request("https://api.example.org/api/missing/stats"),
      cache,
      tenant: TENANT,
      corsOrigins: CORS,
      fetchOrigin: async () => new Response("{}", {
        headers: { "Cache-Control": "public, max-age=0, s-maxage=5" },
      }),
      waitUntil: (promise) => pending.push(promise),
    });
    await Promise.all(pending);
    expect(response.headers.get("x-json-edge-cache")).toBe("miss");
    expect(putCount()).toBe(1);
  });

  it("serves a hit without calling Express", async () => {
    const { cache } = fakeCache(new Response('{"cached":true}', {
      headers: { "Cache-Control": "public, s-maxage=5" },
    }));
    let originCalls = 0;
    const response = await servePublicJsonCached({
      request: new Request("https://api.example.org/api/missing/stats"),
      cache,
      tenant: TENANT,
      corsOrigins: CORS,
      fetchOrigin: async () => {
        originCalls++;
        return new Response("{}");
      },
      waitUntil: () => {},
    });
    expect(originCalls).toBe(0);
    expect(response.headers.get("x-json-edge-cache")).toBe("hit");
    expect(await response.json()).toEqual({ cached: true });
  });

  it("partitions reflected CORS responses by allowlisted Origin only", async () => {
    const { cache, keys } = fakeCache();
    await servePublicJsonCached({
      request: new Request("https://api.example.org/api/missing", {
        headers: { Origin: "https://web.example.org" },
      }),
      cache,
      tenant: TENANT,
      corsOrigins: CORS,
      fetchOrigin: async () => new Response("{}"),
      waitUntil: () => {},
    });
    expect(new URL(keys[0]!).searchParams.get("__edge_origin")).toBe(
      "https://web.example.org",
    );
    expect(new URL(keys[0]!).searchParams.get("__edge_tenant")).toBe(
      "org_mallanet:inc_terremoto_colombia_2026:0",
    );
  });

  it("does not unbounded-key the cache on an arbitrary Origin", async () => {
    const { cache, keys } = fakeCache();
    await servePublicJsonCached({
      request: new Request("https://api.example.org/api/missing", {
        headers: { Origin: "https://attacker.example.org" },
      }),
      cache,
      tenant: TENANT,
      corsOrigins: CORS,
      fetchOrigin: async () => new Response("{}"),
      waitUntil: () => {},
    });
    expect(new URL(keys[0]!).searchParams.get("__edge_origin")).toBe("none");
  });

  it("partitions cache keys by tenant", async () => {
    const { cache, keys } = fakeCache();
    await servePublicJsonCached({
      request: new Request("https://api.example.org/api/missing"),
      cache,
      tenant: TENANT,
      corsOrigins: CORS,
      fetchOrigin: async () => new Response("{}"),
      waitUntil: () => {},
    });
    await servePublicJsonCached({
      request: new Request("https://api.example.org/api/missing"),
      cache,
      tenant: OTHER_TENANT,
      corsOrigins: CORS,
      fetchOrigin: async () => new Response("{}"),
      waitUntil: () => {},
    });
    expect(new URL(keys[0]!).searchParams.get("__edge_tenant")).not.toBe(
      new URL(keys[1]!).searchParams.get("__edge_tenant"),
    );
  });

  it("bypasses cache for authenticated requests and private responses", async () => {
    for (const request of [
      new Request("https://api.example.org/api/missing", { headers: { Cookie: "session=x" } }),
      new Request("https://api.example.org/api/missing", { headers: { Authorization: "Bearer x" } }),
    ]) {
      const { cache, putCount } = fakeCache(new Response("cached"));
      const response = await servePublicJsonCached({
        request,
        cache,
        tenant: TENANT,
        corsOrigins: CORS,
        fetchOrigin: async () => new Response("private", {
          headers: { "Cache-Control": "private, no-store" },
        }),
        waitUntil: () => {},
      });
      expect(await response.text()).toBe("private");
      expect(putCount()).toBe(0);
    }
  });
});
