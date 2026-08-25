import { cookies } from "next/headers";
import { getCloudflareContext } from "@opennextjs/cloudflare";

const SESSION_COOKIE = "mallanet_ops_bff_session";

export function apiUrl(path: string): string {
  const base = process.env.PLATFORM_API_URL ?? "http://localhost:8080";
  return `${base.replace(/\/$/, "")}/api/platform${path}`;
}

type FetchLike = typeof fetch;

export function platformApiFetch(): FetchLike {
  try {
    const env = getCloudflareContext().env as {
      PLATFORM_API?: { fetch: FetchLike };
    };
    if (env.PLATFORM_API) return env.PLATFORM_API.fetch.bind(env.PLATFORM_API);
  } catch {
    // Local Next development has no Cloudflare request context.
  }
  return fetch;
}

export async function platformFetch(path: string, init?: RequestInit): Promise<Response> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const headers = new Headers(init?.headers);
  headers.set("Accept", "application/json");
  if (init?.body) headers.set("Content-Type", "application/json");
  if (token) headers.set("Authorization", `Bearer ${token}`);
  return platformApiFetch()(apiUrl(path), {
    ...init,
    headers,
    cache: "no-store",
    signal: init?.signal ?? AbortSignal.timeout(5_000),
  });
}

export async function forward(response: Response): Promise<Response> {
  return new Response(response.body, {
    status: response.status,
    headers: {
      "Content-Type": response.headers.get("Content-Type") ?? "application/json",
      "Cache-Control": "no-store, private",
    },
  });
}

export const sessionCookie = {
  name: SESSION_COOKIE,
  options: {
    httpOnly: true,
    secure: process.env.OPS_COOKIE_SECURE
      ? process.env.OPS_COOKIE_SECURE === "true"
      : process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    maxAge: 43_200,
  },
};
