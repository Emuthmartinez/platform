/**
 * Public API hostname for tenant lookup (KTD7).
 *
 * Compose SSR/BFF fetches INTERNAL_API_URL / EMERGENCY_API_URL
 * (`http://backend:8080`). That Docker DNS name is not a deployments row.
 * Send the hostname from NEXT_PUBLIC_API_URL (or a public EMERGENCY_API_URL)
 * in x-mallanet-trusted-hostname. Duplicate of the frontend header string:
 * admin must not import backend code.
 */

const TRUSTED_HOSTNAME_HEADER = "x-mallanet-trusted-hostname";
const DOCKER_INTERNAL_HOSTS = new Set(["backend"]);

function hostnameFromUrl(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    const hostname = new URL(raw).hostname.toLowerCase();
    if (!hostname || DOCKER_INTERNAL_HOSTS.has(hostname)) return undefined;
    return hostname;
  } catch {
    return undefined;
  }
}

export function trustedHostnameHeaders(): Record<string, string> {
  const hostname =
    hostnameFromUrl(process.env.NEXT_PUBLIC_API_URL) ??
    hostnameFromUrl(process.env.EMERGENCY_API_URL);
  return hostname ? { [TRUSTED_HOSTNAME_HEADER]: hostname } : {};
}
