/**
 * Dual-write helpers for tenant-scoped rows (U18 / KTD6 C1).
 *
 * Columns are NOT NULL after U8 tighten. Callers pass an explicit TenantScope;
 * AsyncLocalStorage is not an authorization source (KTD13).
 */
import { sql, type SQL } from "drizzle-orm";
import {
  COLOMBIA_INCIDENT_ID,
  COLOMBIA_ORGANIZATION_ID,
} from "@/lib/colombia-tenant";
import { createTenantScope, type TenantScope } from "@/tenant/scope";

export type IncidentOwnership = {
  organizationId: string;
  incidentId: string;
};

export type IncidentAuditOwnership = IncidentOwnership & {
  scopeType: "incident";
};

export type GlobalAuditOwnership = {
  scopeType: "global";
  organizationId: null;
  incidentId: null;
};

export type OrganizationAuditOwnership = {
  scopeType: "organization";
  organizationId: string;
  incidentId: null;
};

/** Hostname used when Cron, Queues, or BullMQ construct a scope. */
export const INTERNAL_EXECUTION_HOSTNAME = "internal";

export function incidentOwnership(scope: TenantScope): IncidentOwnership {
  return {
    organizationId: scope.organizationId,
    incidentId: scope.incidentId,
  };
}

export function incidentAuditOwnership(scope: TenantScope): IncidentAuditOwnership {
  return {
    scopeType: "incident",
    ...incidentOwnership(scope),
  };
}

export function globalAuditOwnership(): GlobalAuditOwnership {
  return {
    scopeType: "global",
    organizationId: null,
    incidentId: null,
  };
}

export function organizationAuditOwnership(
  organizationId: string,
): OrganizationAuditOwnership {
  const id = organizationId.trim();
  if (!id) {
    throw new Error("organization audit ownership requires organizationId.");
  }
  return {
    scopeType: "organization",
    organizationId: id,
    incidentId: null,
  };
}

/** Extra fields on a still-v1 queue body. schemaVersion stays absent. */
export function tenantJobFields(scope: TenantScope): IncidentOwnership {
  return incidentOwnership(scope);
}

export function tenantScopeFromIds(input: {
  organizationId: string;
  incidentId: string;
  hostname?: string;
}): TenantScope {
  return createTenantScope({
    organizationId: input.organizationId,
    incidentId: input.incidentId,
    hostname: input.hostname ?? INTERNAL_EXECUTION_HOSTNAME,
  });
}

/**
 * During dual-write, Colombia Cron still claims pre-U18 NULL rows.
 * A later incident executor must not touch those rows.
 */
export function includesUnscopedLegacyRows(scope: TenantScope): boolean {
  return (
    scope.organizationId === COLOMBIA_ORGANIZATION_ID &&
    scope.incidentId === COLOMBIA_INCIDENT_ID
  );
}

/** SQL predicate for a scoped table that still has NULL tenant columns. */
export function sqlOwnsIncidentOrLegacyNull(
  scope: TenantScope,
  alias?: "t",
): SQL {
  const orgCol = alias === "t" ? sql`t.organization_id` : sql`organization_id`;
  const incCol = alias === "t" ? sql`t.incident_id` : sql`incident_id`;
  if (includesUnscopedLegacyRows(scope)) {
    return sql`(
      (${orgCol} = ${scope.organizationId} AND ${incCol} = ${scope.incidentId})
      OR (${orgCol} IS NULL AND ${incCol} IS NULL)
    )`;
  }
  return sql`(${orgCol} = ${scope.organizationId} AND ${incCol} = ${scope.incidentId})`;
}
