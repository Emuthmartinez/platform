import type { Request, RequestHandler } from "express";
import { env } from "@/config/env";
import { notFound } from "@/lib/errors";
import {
  TRUSTED_HOSTNAME_HEADER,
  UNKNOWN_HOST_ERROR,
  canonicalizeHostname,
  isTenantExemptPath,
} from "@/tenant/hostname";
import { loadDeploymentByHostname } from "@/tenant/resolve";
import type { TenantScope } from "@/tenant/scope";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      tenantScope?: TenantScope;
    }
  }
}

function headerValue(req: Request, name: string): string | undefined {
  const value = req.headers[name];
  if (Array.isArray(value)) return value[0];
  return value;
}

/**
 * Authority for tenant lookup. Ignores X-Forwarded-Host and req.hostname.
 * The Worker or Caddy must overwrite the internal header. Dev/test without
 * that header use PINNED_DEPLOYMENT_HOSTNAME.
 */
export function trustedHostnameFromRequest(req: Request): string | null {
  const fromHeader = canonicalizeHostname(
    headerValue(req, TRUSTED_HOSTNAME_HEADER),
  );
  if (fromHeader) return fromHeader;
  if (env.NODE_ENV === "production") return null;
  return canonicalizeHostname(env.PINNED_DEPLOYMENT_HOSTNAME);
}

export const resolveTenant: RequestHandler = (req, _res, next) => {
  void resolveTenantAsync(req).then(next, next);
};

async function resolveTenantAsync(req: Request): Promise<void> {
  if (isTenantExemptPath(req.path)) return;
  const hostname = trustedHostnameFromRequest(req);
  if (!hostname) {
    throw notFound(UNKNOWN_HOST_ERROR);
  }
  const scope = await loadDeploymentByHostname(hostname);
  if (!scope) {
    throw notFound(UNKNOWN_HOST_ERROR);
  }
  req.tenantScope = scope;
}

export function requireTenantScope(req: Request): TenantScope {
  if (!req.tenantScope) {
    throw notFound(UNKNOWN_HOST_ERROR);
  }
  return req.tenantScope;
}

export function publicApiOrigin(req: Request): string {
  const scope = requireTenantScope(req);
  return `https://${scope.hostname}`;
}
