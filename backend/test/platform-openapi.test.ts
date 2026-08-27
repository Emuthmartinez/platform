import request from "supertest";
import { describe, expect, it } from "vitest";
import "./helpers";

process.env.PLATFORM_JWT_SECRET ??= "test-platform-jwt-secret-not-for-prod-0123456789";

describe("platform OpenAPI contract", () => {
  it("documents every platform route", async () => {
    const { app } = await import("@/server");
    const response = await request(app).get("/api/openapi.json");

    expect(response.status).toBe(200);
    expect(response.body.paths).toMatchObject({
      "/api/platform/readyz": { get: expect.any(Object) },
      "/api/platform/auth/login": { post: expect.any(Object) },
      "/api/platform/auth/access": { post: expect.any(Object) },
      "/api/platform/auth/logout": { post: expect.any(Object) },
      "/api/platform/auth/me": { get: expect.any(Object) },
      "/api/platform/portfolio": { get: expect.any(Object) },
      "/api/platform/provisioning-runs": {
        get: expect.any(Object),
        post: expect.any(Object),
      },
      "/api/platform/provisioning-runs/{id}/approve": { post: expect.any(Object) },
      "/api/platform/provisioning-runs/{id}/apply": { post: expect.any(Object) },
      "/api/platform/operators": { get: expect.any(Object), post: expect.any(Object) },
      "/api/platform/operators/{id}": { patch: expect.any(Object) },
    });
  });
});
