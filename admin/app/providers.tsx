"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { AdminSessionProvider } from "../src/shared/auth/admin-session-provider";
import { clearClientQueriesOnScopeChange } from "../src/lib/query-scope";

function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        refetchOnWindowFocus: false,
        retry: 1,
      },
    },
  });
}

/**
 * Client-side providers: TanStack Query + sesión RBAC.
 * useState con inicializador lazy crea un QueryClient por montaje (no por
 * render). AdminSessionProvider deriva la sesión de /api/auth/me.
 */
export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState<QueryClient>(() => {
    const client = makeQueryClient();
    clearClientQueriesOnScopeChange(client);
    return client;
  });
  return (
    <QueryClientProvider client={queryClient}>
      <AdminSessionProvider>{children}</AdminSessionProvider>
    </QueryClientProvider>
  );
}
