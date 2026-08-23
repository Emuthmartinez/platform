/**
 * U9 tenant resolution: trusted hostname → deployments → TenantScope.
 * Uses the real Express app against local Postgres (CI migrates first).
 */
import { beforeAll, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import "./helpers";
import {
  COLOMBIA_INCIDENT_ID,
  COLOMBIA_ORGANIZATION_ID,
} from "@/lib/colombia-tenant";
import { UNKNOWN_HOST_ERROR } from "@/tenant/hostname";

let app: import("express").Express;

beforeAll(async () => {
  app = (await import("@/server")).app;
});

const SEEDED_HOSTNAMES = [
  "terremotocolombia.co",
  "api.terremotocolombia.co",
  "admin.terremotocolombia.co",
  "staging.terremotocolombia.co",
  "api-staging.terremotocolombia.co",
  "admin-staging.terremotocolombia.co",
  "localhost",
];

describe("U9 tenant resolution", () => {
  it("returns a generic 404 and does not run a tenant-scoped handler", async () => {
    const { resolveTenant } = await import("@/middleware/tenant");
    const { errorHandler } = await import("@/middleware");
    const scoped = express();
    const handler = vi.fn((_req, res) => {
      res.json({ ran: true });
    });
    scoped.use(resolveTenant);
    scoped.get("/api/reports", handler);
    scoped.use(errorHandler);

    const res = await request(scoped)
      .get("/api/reports")
      .set("x-mallanet-trusted-hostname", "no-such-host.example.org")
      .set("x-forwarded-host", "api.terremotocolombia.co")
      .set("host", "api.terremotocolombia.co");

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: UNKNOWN_HOST_ERROR });
    expect(handler).not.toHaveBeenCalled();
  });

  it("ignores a forged X-Forwarded-Host when the trusted carrier is unknown", async () => {
    const res = await request(app)
      .get("/api/reports")
      .set("x-mallanet-trusted-hostname", "forged.example.org")
      .set("x-forwarded-host", "api.terremotocolombia.co")
      .set("host", "api.terremotocolombia.co");
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: UNKNOWN_HOST_ERROR });
  });

  it("resolves mixed-case and trailing-dot staging hostnames", async () => {
    const res = await request(app)
      .get("/api/reports")
      .set("x-mallanet-trusted-hostname", "API-Staging.TerremotoColombia.co.");
    expect(res.status).toBe(200);
  });

  it("uses the env pin when Host carries a port and no trusted header is set", async () => {
    const res = await request(app)
      .get("/api/reports")
      .set("Host", "localhost:8080")
      .set("X-Forwarded-Host", "evil.example.org");
    expect(res.status).toBe(200);
  });

  it("serves healthz without a tenant even for an unknown host", async () => {
    const res = await request(app)
      .get("/api/healthz")
      .set("x-mallanet-trusted-hostname", "no-such-host.example.org");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it("maps every seeded hostname class to the Colombia org and incident", async () => {
    const { loadDeploymentByHostname } = await import("@/tenant/resolve");
    for (const hostname of SEEDED_HOSTNAMES) {
      const scope = await loadDeploymentByHostname(hostname);
      expect(scope?.organizationId, hostname).toBe(COLOMBIA_ORGANIZATION_ID);
      expect(scope?.incidentId, hostname).toBe(COLOMBIA_INCIDENT_ID);
    }
  });
});
