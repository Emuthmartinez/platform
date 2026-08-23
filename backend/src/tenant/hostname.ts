/**
 * Trusted hostname authority (KTD7).
 *
 * Express `req.hostname` / `req.host` follow X-Forwarded-Host when
 * `trust proxy` is on. That header is client-settable. Tenant lookup
 * uses this canonical value only.
 */
export const TRUSTED_HOSTNAME_HEADER = "x-mallanet-trusted-hostname";

export const UNKNOWN_HOST_ERROR = "Ruta no encontrada.";

export function canonicalizeHostname(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (/[\s,/@\\]/.test(trimmed)) return null;
  if (trimmed.includes(":")) return null;
  const lower = trimmed.toLowerCase();
  const withoutDot = lower.replace(/\.+$/, "");
  if (!withoutDot) return null;
  return withoutDot;
}

/** True when development must fail at boot instead of per-request. */
export function developmentPinMissing(
  nodeEnv: string,
  pin: string | undefined,
): boolean {
  return nodeEnv === "development" && !pin?.trim();
}

/**
 * Drop any client copy of the internal carrier, then set it from the
 * Worker URL hostname (KTD7). Express never reads Host / X-Forwarded-Host.
 */
export function overwriteTrustedHostnameHeader(request: Request): {
  headers: Headers;
  canonical: string | null;
} {
  const headers = new Headers(request.headers);
  headers.delete(TRUSTED_HOSTNAME_HEADER);
  const canonical = canonicalizeHostname(new URL(request.url).hostname);
  if (canonical) headers.set(TRUSTED_HOSTNAME_HEADER, canonical);
  return { headers, canonical };
}

export function isTenantExemptPath(pathname: string): boolean {
  const path = pathname.endsWith("/") && pathname.length > 1
    ? pathname.slice(0, -1)
    : pathname;
  return path === "/api/healthz" || path === "/api/readyz";
}

export function unknownHostPayload(): { error: string } {
  return { error: UNKNOWN_HOST_ERROR };
}
