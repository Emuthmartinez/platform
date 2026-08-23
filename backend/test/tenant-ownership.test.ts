import { describe, expect, it } from "vitest";
import {
  COLOMBIA_INCIDENT_ID,
  COLOMBIA_ORGANIZATION_ID,
  colombiaTenantScope,
} from "@/lib/colombia-tenant";
import { createTenantScope } from "@/tenant/scope";
import {
  globalAuditOwnership,
  includesUnscopedLegacyRows,
  incidentAuditOwnership,
  incidentOwnership,
  INTERNAL_EXECUTION_HOSTNAME,
  organizationAuditOwnership,
  tenantJobFields,
  tenantScopeFromIds,
} from "@/tenant/ownership";

describe("incident ownership helpers", () => {
  it("copies organization and incident from TenantScope", () => {
    const scope = colombiaTenantScope("api-staging.terremotocolombia.co");
    expect(incidentOwnership(scope)).toEqual({
      organizationId: COLOMBIA_ORGANIZATION_ID,
      incidentId: COLOMBIA_INCIDENT_ID,
    });
    expect(incidentAuditOwnership(scope)).toEqual({
      scopeType: "incident",
      organizationId: COLOMBIA_ORGANIZATION_ID,
      incidentId: COLOMBIA_INCIDENT_ID,
    });
    expect(tenantJobFields(scope)).toEqual(incidentOwnership(scope));
  });

  it("builds mixed-scope audit rows without inventing an incident", () => {
    expect(globalAuditOwnership()).toEqual({
      scopeType: "global",
      organizationId: null,
      incidentId: null,
    });
    expect(organizationAuditOwnership("org_mallanet")).toEqual({
      scopeType: "organization",
      organizationId: "org_mallanet",
      incidentId: null,
    });
  });

  it("constructs a queue/cron scope without a public hostname", () => {
    const scope = tenantScopeFromIds({
      organizationId: COLOMBIA_ORGANIZATION_ID,
      incidentId: COLOMBIA_INCIDENT_ID,
    });
    expect(scope.hostname).toBe(INTERNAL_EXECUTION_HOSTNAME);
    expect(includesUnscopedLegacyRows(scope)).toBe(true);
    expect(
      includesUnscopedLegacyRows(
        createTenantScope({
          organizationId: "org_other",
          incidentId: "inc_other",
          hostname: "other.example.org",
        }),
      ),
    ).toBe(false);
  });
});
