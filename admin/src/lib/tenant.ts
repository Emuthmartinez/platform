/**
 * First-tenant identifiers. Keep in sync with backend/src/lib/colombia-tenant.ts
 * and backend/src/tenant/scope.ts (epoch 0 until U34).
 */
export const COLOMBIA_ORGANIZATION_ID = "org_mallanet";
export const COLOMBIA_INCIDENT_ID = "inc_terremoto_colombia_2026";
export const TENANT_CACHE_EPOCH = 0;

export function tenantQueryPartition(): string {
  return `${COLOMBIA_ORGANIZATION_ID}:${COLOMBIA_INCIDENT_ID}:${TENANT_CACHE_EPOCH}`;
}
