import type { QueryClient } from "@tanstack/react-query";
import { tenantQueryPartition } from "@/lib/tenant";

let lastPartition: string | null = null;

/**
 * Clear the TanStack Query cache when org/incident/epoch changes.
 * Today the partition is constant. The hook is in place before the admin
 * incident selector ships.
 */
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
