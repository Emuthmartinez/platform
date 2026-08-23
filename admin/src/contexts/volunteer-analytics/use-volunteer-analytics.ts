"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { adminFetch } from "@/src/shared/http/admin-fetch";
import { scopedQueryKey } from "@/src/lib/query-scope";
import type { VolunteerAnalyticsResponse } from "./types";

export function volunteerAnalyticsQueryKey(since: string | null) {
  return scopedQueryKey("volunteer-analytics", since);
}

async function fetchAnalytics(opts: {
  since: string | null;
  refresh?: boolean;
}): Promise<VolunteerAnalyticsResponse> {
  const qs = new URLSearchParams();
  if (opts.since) qs.set("since", opts.since);
  if (opts.refresh) qs.set("refresh", "1");
  const suffix = qs.toString() ? `?${qs.toString()}` : "";
  const res = await adminFetch(`/api/admin/volunteer-analytics${suffix}`);
  const body = (await res.json().catch(() => null)) as
    | VolunteerAnalyticsResponse
    | { error?: string }
    | null;
  if (!res.ok) {
    const err = new Error(
      (body as { error?: string } | null)?.error ?? `Error ${res.status}`,
    ) as Error & { status?: number };
    err.status = res.status;
    throw err;
  }
  return body as VolunteerAnalyticsResponse;
}

export function useVolunteerAnalytics(since: string | null = null) {
  return useQuery({
    queryKey: volunteerAnalyticsQueryKey(since),
    queryFn: () => fetchAnalytics({ since, refresh: false }),
    staleTime: 60_000,
    refetchOnWindowFocus: true,
  });
}

export function useRefreshVolunteerAnalytics(since: string | null = null) {
  const qc = useQueryClient();
  return async () => {
    const fresh = await fetchAnalytics({ since, refresh: true });
    qc.setQueryData(volunteerAnalyticsQueryKey(since), fresh);
    return fresh;
  };
}
