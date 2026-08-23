/**
 * U7 core catalog: Colombia org/incident/deployments from the seed migration,
 * and the KTD14 composite FK rejects a mixed organization/incident pair.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import "./helpers";
import {
  COLOMBIA_INCIDENT_ID,
  COLOMBIA_INCIDENT_NAME,
  COLOMBIA_ORGANIZATION_ID,
  COLOMBIA_ORGANIZATION_NAME,
} from "@/lib/colombia-tenant";

const HERE = dirname(fileURLToPath(import.meta.url));
const deploymentConfig = JSON.parse(
  readFileSync(
    join(HERE, "../../config/deployment.config.json"),
    "utf8",
  ),
) as { orgName: string; disasterName: string; domains: Record<string, string> };

const extraOrgId = `org_test_${randomUUID().slice(0, 8)}`;
const extraIncidentId = `inc_test_${randomUUID().slice(0, 8)}`;

describe("U7 platform core tenant catalog", () => {
  // CI applies migrations first. Local compose without migrate has no tables.
  afterAll(async () => {
    const { getDb, schema } = await import("@/db");
    const db = getDb();
    await db
      .delete(schema.incidents)
      .where(eq(schema.incidents.id, extraIncidentId));
    await db
      .delete(schema.organizations)
      .where(eq(schema.organizations.id, extraOrgId));
  });

  it("seeds the Colombia organization, incident, and deployment hostnames", async () => {
    const { getDb, schema } = await import("@/db");
    const db = getDb();

    const [org] = await db
      .select()
      .from(schema.organizations)
      .where(eq(schema.organizations.id, COLOMBIA_ORGANIZATION_ID));
    expect(org?.name).toBe(COLOMBIA_ORGANIZATION_NAME);
    expect(org?.name).toBe(deploymentConfig.orgName);

    const [incident] = await db
      .select()
      .from(schema.incidents)
      .where(eq(schema.incidents.id, COLOMBIA_INCIDENT_ID));
    expect(incident?.organizationId).toBe(COLOMBIA_ORGANIZATION_ID);
    expect(incident?.name).toBe(COLOMBIA_INCIDENT_NAME);
    expect(incident?.name).toBe(deploymentConfig.disasterName);

    const rows = await db.select().from(schema.deployments);
    const hostnames = rows.map((r) => r.hostname).sort();
    expect(hostnames).toEqual(
      [
        deploymentConfig.domains.admin,
        deploymentConfig.domains.api,
        deploymentConfig.domains.web,
      ].sort(),
    );
    for (const row of rows) {
      expect(row.organizationId).toBe(COLOMBIA_ORGANIZATION_ID);
      expect(row.incidentId).toBe(COLOMBIA_INCIDENT_ID);
    }
  });

  it("rejects a deployment that pairs organization A with incident B", async () => {
    const { getDb, schema } = await import("@/db");
    const db = getDb();
    const now = Date.now();

    await db.insert(schema.organizations).values({
      id: extraOrgId,
      name: "DEMO Extra Org",
      createdAt: now,
    });
    await db.insert(schema.incidents).values({
      id: extraIncidentId,
      organizationId: extraOrgId,
      name: "DEMO Extra Incident",
      createdAt: now,
    });

    let caught: unknown;
    try {
      await db.insert(schema.deployments).values({
        hostname: `demo-${randomUUID().slice(0, 8)}.example.org`,
        organizationId: COLOMBIA_ORGANIZATION_ID,
        incidentId: extraIncidentId,
        createdAt: now,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught, "mixed org/incident pair must fail").toBeTruthy();
    const blob =
      caught instanceof Error
        ? `${caught.message}\n${caught.cause instanceof Error ? caught.cause.message : String(caught.cause ?? "")}`
        : String(caught);
    expect(blob).toMatch(/incident_ownership|23503|foreign key/i);
  });
});
