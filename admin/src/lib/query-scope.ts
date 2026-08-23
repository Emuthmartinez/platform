import type { QueryClient } from "@tanstack/react-query";
import {
  COLOMBIA_INCIDENT_ID,
  COLOMBIA_ORGANIZATION_ID,
  TENANT_CACHE_EPOCH,
  tenantQueryPartition,
} from "@/src/lib/tenant";

export function scopedQueryKey<T extends readonly unknown[]>(
  ...key: T
): readonly [string, string, number, ...T] {
  return [COLOMBIA_ORGANIZATION_ID, COLOMBIA_INCIDENT_ID, TENANT_CACHE_EPOCH, ...key] as const;
}

let lastPartition: string | null = null;

export function clearClientQueriesOnScopeChange(client: QueryClient): void {
  const now = tenantQueryPartition();
  if (lastPartition !== null && lastPartition !== now) {
    client.clear();
  }
  lastPartition = now;
}

export function resetQueryScopeForTests(): void {
  lastPartition = null;
}
