/**
 * Immutable tenant authorization context (KTD21).
 * Request correlation IDs live in request-context.ts and must not
 * substitute for this type.
 */
export const TENANT_CACHE_EPOCH = 0;

export interface TenantScope {
  readonly organizationId: string;
  readonly incidentId: string;
  readonly hostname: string;
  readonly cacheEpoch: number;
}

export function createTenantScope(input: {
  organizationId: string;
  incidentId: string;
  hostname: string;
  cacheEpoch?: number;
}): TenantScope {
  const organizationId = input.organizationId.trim();
  const incidentId = input.incidentId.trim();
  const hostname = input.hostname.trim();
  if (!organizationId || !incidentId || !hostname) {
    throw new Error("TenantScope requires organization, incident, and hostname.");
  }
  return Object.freeze({
    organizationId,
    incidentId,
    hostname,
    cacheEpoch: input.cacheEpoch ?? TENANT_CACHE_EPOCH,
  });
}

export function tenantCachePartition(scope: TenantScope): string {
  return `${scope.organizationId}:${scope.incidentId}:${scope.cacheEpoch}`;
}

export function tenantRateLimitPartition(scope: TenantScope | undefined): string {
  return scope
    ? `${scope.organizationId}:${scope.incidentId}`
    : "unscoped";
}
