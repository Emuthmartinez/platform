/**
 * First-tenant identifiers for the Colombia installation.
 * Keep in sync with backend/src/lib/colombia-tenant.ts and
 * backend/src/tenant/scope.ts (epoch 0 until U34).
 * Hostnames come from config/deployment.config.json, not from this file.
 */
export const COLOMBIA_ORGANIZATION_ID = "org_mallanet";
export const COLOMBIA_INCIDENT_ID = "inc_terremoto_colombia_2026";
/** Cache epoch. Stays 0 until U34. */
export const TENANT_CACHE_EPOCH = 0;

/** Rescue-map JSON incident id (distinct from the tenant incident id). */
export const COLOMBIA_RESCUE_INCIDENT_ID =
  "colombia-2026-08-10-san-jose-del-palmar";

export const COLOMBIA_RESCUE_DATA_PATHS = [
  "/data/incidents/colombia-2026-08-10-san-jose-del-palmar.json",
  "/data/incidents/colombia-2026-08-10-emsr916-map.json",
] as const;

export function tenantQueryPartition(): string {
  return `${COLOMBIA_ORGANIZATION_ID}:${COLOMBIA_INCIDENT_ID}:${TENANT_CACHE_EPOCH}`;
}
