import { describe, expect, it } from "vitest";
import {
  OfflineDraftQuotaError,
  decodeOfflineDraft,
  evaluateDraftQuota,
  exportOfflineDraftJson,
  isV1OfflineDraft,
  mayAutoDeleteDraft,
  migrateV1OfflineDraft,
  newDraftFromPayload,
  type OfflineDraft,
} from "@/lib/offline-draft-protocol";
import { COLOMBIA_INCIDENT_ID, COLOMBIA_ORGANIZATION_ID } from "@/lib/tenant";

const v1 = {
  localId: "demo-local-1",
  createdAt: Date.now() - 60_000,
  payload: {
    type: "need" as const,
    lat: 4.6,
    lng: -74.1,
    place: "DEMO-Plaza",
    affected: 2,
    needs: "DEMO-Agua",
    photo: null,
  },
};

describe("offline draft protocol", () => {
  it("detects a v1 IndexedDB row", () => {
    expect(isV1OfflineDraft(v1)).toBe(true);
    expect(isV1OfflineDraft({ schemaVersion: 2, ...v1 })).toBe(false);
  });

  it("migrates v1 to verification_required with Colombia tenant ids", () => {
    const draft = migrateV1OfflineDraft(v1);
    expect(draft).toMatchObject({
      schemaVersion: 2,
      localId: "demo-local-1",
      organizationId: COLOMBIA_ORGANIZATION_ID,
      incidentId: COLOMBIA_INCIDENT_ID,
      idempotencyKey: "demo-local-1",
      status: "verification_required",
      payload: v1.payload,
    });
  });

  it("does not persist a Turnstile token in a new draft", () => {
    const draft = newDraftFromPayload(
      {
        ...v1.payload,
        turnstileToken: "demo-single-use-proof",
      } as typeof v1.payload & { turnstileToken: string },
      {
        localId: "demo-local-2",
        createdAt: 1,
        status: "verification_required",
        producerBuildSha: "dev",
      },
    );
    expect(draft.payload).not.toHaveProperty("turnstileToken");
  });

  it("marks a foreign tenant draft incompatible and does not auto-delete", () => {
    const decoded = decodeOfflineDraft({
      schemaVersion: 2,
      localId: "demo-foreign",
      organizationId: "org_other",
      incidentId: "inc_other",
      idempotencyKey: "demo-foreign",
      producerBuildSha: "dev",
      createdAt: Date.now(),
      status: "ready",
      payload: v1.payload,
    });
    expect("draft" in decoded).toBe(true);
    if ("draft" in decoded) {
      expect(decoded.draft.status).toBe("incompatible");
    }
    expect(mayAutoDeleteDraft({ confirmedDurableSubmission: false })).toBe(
      false,
    );
  });

  it("expires a draft after 30 days without deleting it", () => {
    const decoded = decodeOfflineDraft({
      schemaVersion: 2,
      localId: v1.localId,
      organizationId: COLOMBIA_ORGANIZATION_ID,
      incidentId: COLOMBIA_INCIDENT_ID,
      idempotencyKey: v1.localId,
      producerBuildSha: "dev",
      createdAt: 0,
      status: "verification_required",
      payload: v1.payload,
    });
    expect("draft" in decoded).toBe(true);
    if ("draft" in decoded) {
      expect(decoded.draft.status).toBe("expired");
    }
  });

  it("rejects a 21st draft and an oversized payload", () => {
    const existing: OfflineDraft[] = Array.from({ length: 20 }, (_, i) =>
      newDraftFromPayload(v1.payload, {
        localId: `demo-${i}`,
        createdAt: i,
        status: "verification_required",
        producerBuildSha: "dev",
      }),
    );
    const extra = newDraftFromPayload(v1.payload, {
      localId: "demo-21",
      createdAt: 21,
      status: "verification_required",
      producerBuildSha: "dev",
    });
    expect(() => evaluateDraftQuota(existing, extra)).toThrow(
      OfflineDraftQuotaError,
    );

    const huge = newDraftFromPayload(
      { ...v1.payload, photo: "x".repeat(1_600_000) },
      {
        localId: "demo-huge",
        createdAt: 1,
        status: "verification_required",
        producerBuildSha: "dev",
      },
    );
    expect(() => evaluateDraftQuota([], huge)).toThrow(OfflineDraftQuotaError);
  });

  it("exports JSON without a Turnstile field", () => {
    const draft = migrateV1OfflineDraft(v1);
    expect(draft).not.toBeNull();
    const json = exportOfflineDraftJson(draft!);
    expect(json).toContain("DEMO-Plaza");
    expect(json).not.toContain("turnstile");
  });
});
