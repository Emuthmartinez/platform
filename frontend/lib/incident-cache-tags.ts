import {
  COLOMBIA_INCIDENT_ID,
  COLOMBIA_ORGANIZATION_ID,
  TENANT_CACHE_EPOCH,
} from "@/lib/tenant";

/** Next.js fetch cache tag for ISR paths that belong to this incident. */
export function incidentCacheTag(): string {
  return `incident:${COLOMBIA_ORGANIZATION_ID}:${COLOMBIA_INCIDENT_ID}:${TENANT_CACHE_EPOCH}`;
}
