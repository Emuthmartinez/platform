// Helper de fetch server-side hacia el backend Express. Mantiene el frontend
// como UI pura: nada de acceso directo a DB. SSR siempre fresco (no-store).
//
// Base URL: INTERNAL_API_URL (red interna en Docker: http://backend:8080) →
// NEXT_PUBLIC_API_URL (público) → localhost en dev.
const BASE_URL =
  process.env.INTERNAL_API_URL ||
  process.env.NEXT_PUBLIC_API_URL ||
  "http://localhost:8080";

const TRUSTED_HOSTNAME_HEADER = "x-mallanet-trusted-hostname";

function trustedHostnameHeaders(): Record<string, string> {
  const publicBase = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8080";
  try {
    const hostname = new URL(publicBase).hostname.toLowerCase();
    if (!hostname) return {};
    return { [TRUSTED_HOSTNAME_HEADER]: hostname };
  } catch {
    return {};
  }
}

export async function serverApiGet<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    cache: "no-store",
    headers: trustedHostnameHeaders(),
  });
  if (!res.ok) {
    throw new Error(`GET ${path} → ${res.status}`);
  }
  return res.json() as Promise<T>;
}

// Variante cacheada (ISR): la página se prerenderiza y se revalida cada N
// segundos en vez de pegar al backend por request. Para datos estables (p. ej.
// el directorio de hospitales) bajo tráfico alto.
export async function serverApiGetCached<T>(
  path: string,
  revalidateSeconds: number,
): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    next: { revalidate: revalidateSeconds },
    headers: trustedHostnameHeaders(),
  });
  if (!res.ok) {
    throw new Error(`GET ${path} → ${res.status}`);
  }
  return res.json() as Promise<T>;
}

// Variante para detalle: devuelve null en 404 (para notFound()).
export async function serverApiGetOrNull<T>(path: string): Promise<T | null> {
  const res = await fetch(`${BASE_URL}${path}`, {
    cache: "no-store",
    headers: trustedHostnameHeaders(),
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`GET ${path} → ${res.status}`);
  }
  return res.json() as Promise<T>;
}
