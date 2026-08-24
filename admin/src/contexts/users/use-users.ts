"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { adminFetch } from "@/src/shared/http/admin-fetch";
import { scopedQueryKey } from "@/src/lib/query-scope";

export type UserStatus = "invited" | "active" | "disabled";

export interface User {
  id: string;
  email: string;
  name: string;
  roleId: string | null;
  status: UserStatus;
  isSuperAdmin: boolean;
  createdAt: number;
  lastLoginAt: number | null;
}

export interface UpdateUserInput {
  roleId?: string | null;
  status?: "active" | "disabled";
  name?: string;
  isSuperAdmin?: boolean;
}

const USERS_KEY = scopedQueryKey("admin", "users");

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

export function useUsers() {
  return useQuery({
    queryKey: USERS_KEY,
    queryFn: async () => {
      const res = await adminFetch("/api/admin/users");
      if (!res.ok) throw new Error(`Error ${res.status}`);
      return (await res.json()) as User[];
    },
  });
}

export function useUpdateUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdateUserInput }) =>
      mutateJson<User>(`/api/admin/users/${id}`, "PATCH", input),
    onSuccess: () => qc.invalidateQueries({ queryKey: USERS_KEY }),
  });
}

/** Suspender = soft delete (status:disabled). Usa DELETE del backend. */
export function useSuspendUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => mutateJson<{ ok: boolean }>(`/api/admin/users/${id}`, "DELETE"),
    onSuccess: () => qc.invalidateQueries({ queryKey: USERS_KEY }),
  });
}
