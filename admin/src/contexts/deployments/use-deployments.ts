"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { adminFetch } from "@/src/shared/http/admin-fetch";
import { scopedQueryKey } from "@/src/lib/query-scope";

export interface DeploymentRow {
  hostname: string;
  organizationId: string;
  incidentId: string;
  organizationName: string;
  incidentName: string;
  createdAt: number;
}

export interface OrganizationOption {
  id: string;
  name: string;
}

export interface IncidentOption {
  id: string;
  organizationId: string;
  name: string;
}

export interface DeploymentCatalog {
  items: DeploymentRow[];
  organizations: OrganizationOption[];
  incidents: IncidentOption[];
}

const DEPLOYMENTS_KEY = scopedQueryKey("admin", "deployments");

async function mutateJson<T>(url: string, method: string, body?: unknown): Promise<T> {
  const res = await adminFetch(url, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    credentials: "same-origin",
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const b = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(b.error ?? `Error ${res.status}`);
  }
  return (await res.json()) as T;
}

export function useDeploymentCatalog() {
  return useQuery({
    queryKey: DEPLOYMENTS_KEY,
    queryFn: async () => {
      const res = await adminFetch("/api/admin/deployments");
      if (!res.ok) throw new Error(`Error ${res.status}`);
      return (await res.json()) as DeploymentCatalog;
    },
  });
}

export function useCreateDeployment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { hostname: string; organizationId: string; incidentId: string }) =>
      mutateJson<{ item: DeploymentRow }>("/api/admin/deployments", "POST", input),
    onSuccess: () => qc.invalidateQueries({ queryKey: DEPLOYMENTS_KEY }),
  });
}

export function useDeleteDeployment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (hostname: string) =>
      mutateJson<{ ok: boolean }>(`/api/admin/deployments/${encodeURIComponent(hostname)}`, "DELETE"),
    onSuccess: () => qc.invalidateQueries({ queryKey: DEPLOYMENTS_KEY }),
  });
}
