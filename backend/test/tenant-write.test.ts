/**
 * U18 dual-write: new citizen rows carry Colombia org/incident without a
 * backfill, and needs status lookups do not cross incidents (R9).
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import "./helpers";
import request from "supertest";
import {
  COLOMBIA_INCIDENT_ID,
  COLOMBIA_ORGANIZATION_ID,
  colombiaTenantScope,
} from "@/lib/colombia-tenant";
import { createTenantScope } from "@/tenant/scope";
import { registerJobBindings, resetJobBindings } from "@/lib/job-dispatch";
import {
  enqueueNeedPublication,
  getNeedPublicationState,
  recordNeedPublicationState,
} from "@/modules/needs/infrastructure/needs-publication-queue";

const extraOrgId = `org_u18_${crypto.randomUUID().slice(0, 8)}`;
const extraIncidentId = `inc_u18_${crypto.randomUUID().slice(0, 8)}`;

let app: import("express").Express;

beforeAll(async () => {
  const { ensureSeed } = await import("./helpers");
  await ensureSeed();
  app = (await import("@/server")).app;

  const { getDb, schema } = await import("@/db");
  const now = Date.now();
  await getDb().insert(schema.organizations).values({
    id: extraOrgId,
    name: "DEMO U18 Extra Org",
    createdAt: now,
  });
  await getDb().insert(schema.incidents).values({
    id: extraIncidentId,
    organizationId: extraOrgId,
    name: "DEMO U18 Extra Incident",
    createdAt: now,
  });
});

afterAll(async () => {
  const { getDb, schema } = await import("@/db");
  await getDb()
    .delete(schema.incidents)
    .where(eq(schema.incidents.id, extraIncidentId));
  await getDb()
    .delete(schema.organizations)
    .where(eq(schema.organizations.id, extraOrgId));
  resetJobBindings();
});

describe("U18 dual-write on citizen creates", () => {
  it("stamps Colombia org/incident on a new report without a backfill", async () => {
    const res = await request(app).post("/api/reports").send({
      type: "critical",
      lat: 10.5,
      lng: -66.9,
      place: `U18 dual-write ${crypto.randomUUID().slice(0, 8)}`,
      affected: 1,
      needs: "Agua (demo)",
    });
    expect(res.status).toBe(201);
    const id = res.body.report.id as string;
    const { getDb, schema } = await import("@/db");
    const [row] = await getDb()
      .select({
        organizationId: schema.reports.organizationId,
        incidentId: schema.reports.incidentId,
      })
      .from(schema.reports)
      .where(eq(schema.reports.id, id));
    expect(row?.organizationId).toBe(COLOMBIA_ORGANIZATION_ID);
    expect(row?.incidentId).toBe(COLOMBIA_INCIDENT_ID);
  });

  it("stamps Colombia org/incident on a new chat message", async () => {
    const res = await request(app).post("/api/chat").send({
      name: "DEMO U18",
      text: `mensaje dual-write ${crypto.randomUUID().slice(0, 8)}`,
      role: "citizen",
    });
    expect(res.status).toBe(201);
    const id = res.body.message.id as string;
    const { getDb, schema } = await import("@/db");
    const [row] = await getDb()
      .select({
        organizationId: schema.chatMessages.organizationId,
        incidentId: schema.chatMessages.incidentId,
      })
      .from(schema.chatMessages)
      .where(eq(schema.chatMessages.id, id));
    expect(row?.organizationId).toBe(COLOMBIA_ORGANIZATION_ID);
    expect(row?.incidentId).toBe(COLOMBIA_INCIDENT_ID);
  });

  it("stamps Colombia org/incident on a new patient import without a backfill", async () => {
    const { createImport } = await import("@/services/patient-imports");
    const created = await createImport(
      {
        source: "u18-dual-write",
        rows: [{ name: "DEMO U18 Import", hospital: "Hospital Demo" }],
      },
      null,
      colombiaTenantScope(),
    );
    const { getDb, schema } = await import("@/db");
    const [row] = await getDb()
      .select({
        organizationId: schema.patientImports.organizationId,
        incidentId: schema.patientImports.incidentId,
      })
      .from(schema.patientImports)
      .where(eq(schema.patientImports.id, created.id));
    expect(row?.organizationId).toBe(COLOMBIA_ORGANIZATION_ID);
    expect(row?.incidentId).toBe(COLOMBIA_INCIDENT_ID);
  });
});

describe("U18 needs publication tenant boundary", () => {
  it("hides incident A's job status from incident B", async () => {
    registerJobBindings({
      NEEDS_QUEUE: { send: vi.fn().mockResolvedValue(undefined) },
    });
    const colombia = colombiaTenantScope();
    const other = createTenantScope({
      organizationId: extraOrgId,
      incidentId: extraIncidentId,
      hostname: "other.example.org",
    });
    const jobId = `need-u18-${crypto.randomUUID()}`;
    await recordNeedPublicationState(jobId, "queued", colombia);
    expect(await getNeedPublicationState(jobId, colombia)).toMatchObject({
      jobId,
      state: "queued",
    });
    expect(await getNeedPublicationState(jobId, other)).toBeNull();
    resetJobBindings();
  });

  it("puts organization and incident on the still-v1 needs payload", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    registerJobBindings({ NEEDS_QUEUE: { send } });
    const scope = colombiaTenantScope();
    const jobId = await enqueueNeedPublication(
      {
        need: {
          title: "Agua demo",
          description: null,
          priority: "high",
          address: "Ciudad Ejemplo",
          items: [{ name: "Agua", quantity: 1, unit: null, category: "water" }],
          author: null,
        },
      },
      scope,
    );
    expect(send).toHaveBeenCalledTimes(1);
    const body = send.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(body.schemaVersion).toBeUndefined();
    expect(body.organizationId).toBe(COLOMBIA_ORGANIZATION_ID);
    expect(body.incidentId).toBe(COLOMBIA_INCIDENT_ID);
    expect(body.jobId).toBe(jobId);
    resetJobBindings();
  });
});
