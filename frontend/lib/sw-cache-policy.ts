import {
  COLOMBIA_INCIDENT_ID,
  COLOMBIA_ORGANIZATION_ID,
  COLOMBIA_RESCUE_DATA_PATHS,
  TENANT_CACHE_EPOCH,
} from "@/lib/tenant";

/** CacheStorage names this worker may delete. Foreign names stay. */
export const SW_OWNED_CACHE_PREFIX = "mallanet-";

const PREVIOUS_V9_CACHE_NAMES = [
  "static-v9",
  "photos-v9",
  "api-v9",
  "html-v9",
  "rescue-data-v9",
] as const;

export const SW_PUBLIC_JSON_PATH_PREFIXES = [
  "/api/missing",
  "/api/deceased",
  "/api/pets",
  "/api/reports",
  "/api/hospitals",
  "/api/earthquakes",
  "/api/donations",
  "/api/acopio",
  "/api/hub",
  "/api/stats/psychology-help",
] as const;

export const SW_PUBLIC_JSON_DENY_SUBSTRINGS = [
  "/patients",
  "/chat",
  "/photo",
] as const;

export const SW_PRIVILEGED_HEADER_NAMES = [
  "authorization",
  "cookie",
  "x-admin-token",
  "x-api-key",
  "x-incident-override",
] as const;

export interface SwRuntimeConfig {
  cacheEpoch: number;
  organizationId: string;
  incidentId: string;
  buildSha: string;
  cachePrefix: string;
  cacheNames: {
    static: string;
    photos: string;
    api: string;
    html: string;
    rescue: string;
  };
  previousCacheNames: readonly string[];
  rescueDataPaths: readonly string[];
  publicJsonPathPrefixes: readonly string[];
  publicJsonDenySubstrings: readonly string[];
  privilegedHeaderNames: readonly string[];
}

function tenantCacheBase(): string {
  return `${SW_OWNED_CACHE_PREFIX}e${TENANT_CACHE_EPOCH}-${COLOMBIA_ORGANIZATION_ID}-${COLOMBIA_INCIDENT_ID}`;
}

export function buildSwConfig(buildSha = "dev"): SwRuntimeConfig {
  const base = tenantCacheBase();
  return {
    cacheEpoch: TENANT_CACHE_EPOCH,
    organizationId: COLOMBIA_ORGANIZATION_ID,
    incidentId: COLOMBIA_INCIDENT_ID,
    buildSha,
    cachePrefix: SW_OWNED_CACHE_PREFIX,
    cacheNames: {
      static: `${base}-static`,
      photos: `${base}-photos`,
      api: `${base}-api`,
      html: `${base}-html`,
      rescue: `${base}-rescue`,
    },
    previousCacheNames: PREVIOUS_V9_CACHE_NAMES,
    rescueDataPaths: COLOMBIA_RESCUE_DATA_PATHS,
    publicJsonPathPrefixes: SW_PUBLIC_JSON_PATH_PREFIXES,
    publicJsonDenySubstrings: SW_PUBLIC_JSON_DENY_SUBSTRINGS,
    privilegedHeaderNames: SW_PRIVILEGED_HEADER_NAMES,
  };
}

export function swKeepCacheNames(config: SwRuntimeConfig): Set<string> {
  return new Set([
    config.cacheNames.static,
    config.cacheNames.photos,
    config.cacheNames.api,
    config.cacheNames.html,
    config.cacheNames.rescue,
    ...config.previousCacheNames,
  ]);
}

/**
 * Delete only names this worker owns that are not in the keep set.
 * v9 names stay because they are in KEEP. Foreign prefixes stay because
 * they do not start with cachePrefix.
 */
export function shouldDeleteOwnedCache(
  name: string,
  keep: ReadonlySet<string>,
  prefix: string,
): boolean {
  if (keep.has(name)) return false;
  return name.startsWith(prefix);
}

export function isAnonymousPublicJsonPath(
  pathname: string,
  prefixes: readonly string[] = SW_PUBLIC_JSON_PATH_PREFIXES,
  denySubstrings: readonly string[] = SW_PUBLIC_JSON_DENY_SUBSTRINGS,
): boolean {
  if (denySubstrings.some((part) => pathname.includes(part))) return false;
  return prefixes.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

export function hasPrivilegedHeaderValue(
  getHeader: (name: string) => string | null,
  privileged: readonly string[] = SW_PRIVILEGED_HEADER_NAMES,
): boolean {
  return privileged.some((name) => {
    const value = getHeader(name);
    return typeof value === "string" && value.trim().length > 0;
  });
}
