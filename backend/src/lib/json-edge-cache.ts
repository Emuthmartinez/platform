import { randomUUID } from "node:crypto";
import type { EdgeCache } from "@/lib/photo-edge-cache";
import type { TenantScope } from "@/tenant/scope";
import { tenantCachePartition } from "@/tenant/scope";

function getAppBuildSha(): string {
  const value = process.env.APP_BUILD_SHA;
  if (typeof value !== "string") return "dev";
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : "dev";
}

const PUBLIC_JSON_PATH =
  /^\/api\/(?:missing|deceased|pets|reports|chat|hospitals|earthquakes|donations|patients|acopio|hub)(?:\/.*)?$|^\/api\/stats\/psychology-help\/?$/;
const EDGE_CACHE_LOG_SAMPLE_RATE = 0.01;

type EdgeCacheOutcome = "hit" | "miss_fill" | "miss_uncacheable";

function corsOriginVariant(origin: string | null, allowlist: readonly string[]): string {
  if (!origin) return "none";
  return allowlist.includes(origin) ? origin : "none";
}

function logCacheOutcome(
  request: Request,
  outcome: EdgeCacheOutcome,
  status: number,
  scope: TenantScope,
): void {
  if (Math.random() >= EDGE_CACHE_LOG_SAMPLE_RATE) return;
  const family = new URL(request.url).pathname.split("/")[2] ?? "unknown";
  console.log({
    t: "edge_cache",
    cache: "json",
    family,
    outcome,
    status,
    organization_id: scope.organizationId,
    incident_id: scope.incidentId,
    cache_epoch: scope.cacheEpoch,
    build: getAppBuildSha(),
  });
}

export function isCacheablePublicJsonPath(pathname: string): boolean {
  return PUBLIC_JSON_PATH.test(pathname) && !pathname.endsWith("/photo") &&
    !pathname.endsWith("/resolution-photo");
}

export function jsonEdgeCacheKey(
  request: Request,
  scope: TenantScope,
  corsOrigins: readonly string[],
): Request {
  const origin = request.headers.get("origin");
  const url = new URL(request.url);
  url.searchParams.set("__edge_tenant", tenantCachePartition(scope));
  url.searchParams.set("__edge_origin", corsOriginVariant(origin, corsOrigins));
  return new Request(url, { method: "GET" });
}

function isPublicCacheResponse(response: Response): boolean {
  const control = response.headers.get("cache-control") ?? "";
  return response.status === 200 &&
    /(?:^|,)\s*public\b/i.test(control) &&
    /(?:^|,)\s*s-maxage=\d+/i.test(control) &&
    !response.headers.has("set-cookie");
}

function withFreshRequestId(response: Response): Response {
  const out = new Response(response.body, response);
  out.headers.delete("x-request-id");
  out.headers.set("x-request-id", randomUUID());
  return out;
}

export async function servePublicJsonCached(opts: {
  request: Request;
  cache: EdgeCache;
  fetchOrigin: () => Promise<Response>;
  waitUntil: (p: Promise<unknown>) => void;
  tenant: TenantScope;
  corsOrigins: readonly string[];
}): Promise<Response> {
  if (opts.request.headers.has("authorization") || opts.request.headers.has("cookie")) {
    return withFreshRequestId(await opts.fetchOrigin());
  }

  const key = jsonEdgeCacheKey(opts.request, opts.tenant, opts.corsOrigins);
  const cached = await opts.cache.match(key);
  if (cached) {
    const response = withFreshRequestId(new Response(cached.body, cached));
    response.headers.set("x-json-edge-cache", "hit");
    logCacheOutcome(opts.request, "hit", response.status, opts.tenant);
    return response;
  }

  const fresh = await opts.fetchOrigin();
  const cacheable = isPublicCacheResponse(fresh);
  if (cacheable) {
    const stored = fresh.clone();
    stored.headers.delete("x-request-id");
    opts.waitUntil(opts.cache.put(key, stored));
  }
  const response = withFreshRequestId(new Response(fresh.body, fresh));
  response.headers.set("x-json-edge-cache", "miss");
  logCacheOutcome(
    opts.request,
    cacheable ? "miss_fill" : "miss_uncacheable",
    response.status,
    opts.tenant,
  );
  return response;
}
