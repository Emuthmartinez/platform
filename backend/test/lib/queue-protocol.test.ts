import { describe, expect, it } from "vitest";
import {
  COLOMBIA_INCIDENT_ID,
  COLOMBIA_ORGANIZATION_ID,
} from "@/lib/colombia-tenant";
import {
  decodeImportJob,
  decodeMatcherJob,
  decodeNeedsJob,
  extractPreservedErrorSummary,
  redactQueuePayload,
  requireNeedsJob,
} from "@/lib/queue-protocol";
import { QUEUE_PROTOCOL_FIXTURES } from "@/lib/queue-protocol-schema";

describe("decodeNeedsJob", () => {
  it("maps a live v1 body onto the Colombia tenant", () => {
    const decoded = decodeNeedsJob(QUEUE_PROTOCOL_FIXTURES.needsV1);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.legacy).toBe(true);
    expect(decoded.organizationId).toBe(COLOMBIA_ORGANIZATION_ID);
    expect(decoded.incidentId).toBe(COLOMBIA_INCIDENT_ID);
    expect(decoded.job.jobId).toBe("need-demo-1");
  });

  it("accepts an empty v1 body", () => {
    const decoded = decodeNeedsJob(QUEUE_PROTOCOL_FIXTURES.needsV1Empty);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.legacy).toBe(true);
  });

  it("unwraps a v2 envelope and keeps a foreign tenant", () => {
    const decoded = decodeNeedsJob(QUEUE_PROTOCOL_FIXTURES.needsV2OtherTenant);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.legacy).toBe(false);
    expect(decoded.organizationId).toBe("org_other");
    expect(decoded.incidentId).toBe("inc_other");
    expect(decoded.job.jobId).toBe("need-other-v2");
  });

  it("rejects malformed, unsupported, and wrong-family bodies", () => {
    expect(decodeNeedsJob(null).ok).toBe(false);
    expect(decodeNeedsJob("x")).toEqual({ ok: false, reason: "malformed" });
    expect(decodeNeedsJob(QUEUE_PROTOCOL_FIXTURES.unsupportedVersion)).toEqual({
      ok: false,
      reason: "unsupported_version",
    });
    expect(decodeNeedsJob(QUEUE_PROTOCOL_FIXTURES.wrongFamilyOnNeeds)).toEqual({
      ok: false,
      reason: "wrong_family",
    });
  });
});

describe("decodeImportJob and decodeMatcherJob", () => {
  it("accepts v1 and v2 import fixtures", () => {
    const v1 = decodeImportJob(QUEUE_PROTOCOL_FIXTURES.importsV1);
    expect(v1.ok && v1.legacy && v1.job.importId === "imp-demo-1").toBe(true);
    const v2 = decodeImportJob(QUEUE_PROTOCOL_FIXTURES.importsV2);
    expect(v2.ok && !v2.legacy && v2.job.mode === "apply").toBe(true);
  });

  it("accepts v1 and v2 matcher fixtures", () => {
    const v1 = decodeMatcherJob(QUEUE_PROTOCOL_FIXTURES.matcherV1);
    expect(v1.ok && v1.job.prn === "PRN-DEMO-0001").toBe(true);
    const v2 = decodeMatcherJob(QUEUE_PROTOCOL_FIXTURES.matcherV2);
    expect(v2.ok && v2.job.prn === "PRN-DEMO-0002").toBe(true);
  });
});

describe("requireNeedsJob", () => {
  it("throws on poison so BullMQ retries", () => {
    expect(() => requireNeedsJob("poison")).toThrow(/malformed/);
  });
});

describe("redactQueuePayload", () => {
  it("strips citizen fields and keeps operational ids", () => {
    const redacted = redactQueuePayload({
      jobId: "need-demo-1",
      need: { title: "secret", author: { email: "a@example.org" } },
      fileBase64: "AAAA",
      errorSummary: "Falló el process: timeout",
    });
    expect(redacted).toEqual({
      jobId: "need-demo-1",
      need: "[redacted]",
      fileBase64: "[redacted]",
      errorSummary: "Falló el process: timeout",
    });
  });

  it("recurses into a v2 payload instead of redacting the envelope key", () => {
    const redacted = redactQueuePayload({
      ...QUEUE_PROTOCOL_FIXTURES.importsV2,
      payload: {
        ...QUEUE_PROTOCOL_FIXTURES.importsV2.payload,
        fileBase64: "AAAA",
        errorSummary: "Falló el apply: timeout",
      },
    });
    expect(redacted).toEqual({
      schemaVersion: 2,
      organizationId: "org_mallanet",
      incidentId: "inc_terremoto_colombia_2026",
      idempotencyKey: "imp-demo-v2",
      producerBuildSha: "deadbeef",
      createdAt: 1_786_320_000_000,
      family: "imports",
      payload: {
        importId: "imp-demo-v2",
        mode: "apply",
        actorId: "user-demo-1",
        fileBase64: "[redacted]",
        errorSummary: "Falló el apply: timeout",
      },
    });
  });
});

describe("extractPreservedErrorSummary", () => {
  it("reads a nested v2 payload errorSummary", () => {
    expect(
      extractPreservedErrorSummary({
        ...QUEUE_PROTOCOL_FIXTURES.importsV2,
        payload: {
          ...QUEUE_PROTOCOL_FIXTURES.importsV2.payload,
          errorSummary: "Falló el apply: timeout",
        },
      }),
    ).toBe("Falló el apply: timeout");
  });
});
