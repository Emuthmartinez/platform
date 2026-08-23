import { describe, expect, it } from "vitest";
import { flushReadyDrafts } from "@/lib/offline-draft-flush";
import { newDraftFromPayload } from "@/lib/offline-draft-protocol";

const payload = {
  type: "need" as const,
  lat: 4.6,
  lng: -74.1,
  place: "DEMO-Plaza",
  affected: 1,
  needs: "DEMO-Agua",
  photo: null,
};

describe("flushReadyDrafts", () => {
  it("does not delete a draft on drop (403 / validation)", async () => {
    const removed: string[] = [];
    const ready = newDraftFromPayload(payload, {
      localId: "demo-ready",
      createdAt: 1,
      status: "ready",
      producerBuildSha: "dev",
    });
    await flushReadyDrafts({
      drafts: [ready],
      post: async () => ({ status: "drop", error: "403" }),
      remove: async (id) => {
        removed.push(id);
      },
    });
    expect(removed).toEqual([]);
  });

  it("skips verification_required drafts", async () => {
    const posted: string[] = [];
    const draft = newDraftFromPayload(payload, {
      localId: "demo-verify",
      createdAt: 1,
      status: "verification_required",
      producerBuildSha: "dev",
    });
    await flushReadyDrafts({
      drafts: [draft],
      post: async () => {
        posted.push(draft.localId);
        return { status: "ok" };
      },
      remove: async () => {
        throw new Error("must not delete");
      },
    });
    expect(posted).toEqual([]);
  });

  it("deletes only after a confirmed durable submission", async () => {
    const removed: string[] = [];
    const ready = newDraftFromPayload(payload, {
      localId: "demo-ok",
      createdAt: 1,
      status: "ready",
      producerBuildSha: "dev",
    });
    await flushReadyDrafts({
      drafts: [ready],
      post: async () => ({
        status: "ok",
        report: {
          id: "demo-report",
          type: "need",
          lat: 4.6,
          lng: -74.1,
          place: "DEMO-Plaza",
          affected: 1,
          needs: "DEMO-Agua",
          photoUrl: null,
          confirmations: 0,
          createdAt: 1,
        },
      }),
      remove: async (id) => {
        removed.push(id);
      },
    });
    expect(removed).toEqual(["demo-ok"]);
  });
});
