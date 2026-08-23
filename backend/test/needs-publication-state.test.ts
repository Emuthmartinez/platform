import "./helpers";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { colombiaTenantScope } from "@/lib/colombia-tenant";
import { registerJobBindings, resetJobBindings } from "@/lib/job-dispatch";
import {
  getNeedPublicationState,
  recordNeedPublicationState,
} from "@/modules/needs/infrastructure/needs-publication-queue";

describe("estado durable de publicación en Cloudflare Queues", () => {
  beforeAll(async () => {
    const { ensureSeed } = await import("./helpers");
    await ensureSeed();
  });

  afterEach(() => resetJobBindings());

  it("expone queued y completed sin copiar campos extra del resultado", async () => {
    registerJobBindings({ NEEDS_QUEUE: { send: vi.fn().mockResolvedValue(undefined) } });
    const jobId = `need-status-${crypto.randomUUID()}`;
    const scope = colombiaTenantScope();

    await recordNeedPublicationState(jobId, "queued", scope);
    expect(await getNeedPublicationState(jobId, scope)).toEqual({
      jobId,
      state: "queued",
      progress: null,
      result: null,
      failedReason: null,
    });

    await recordNeedPublicationState(jobId, "completed", scope, {
      result: { id: "external-demo", status: "pending", privateField: "no sale" },
    });
    const completed = await getNeedPublicationState(jobId, scope);
    expect(completed).toEqual({
      jobId,
      state: "completed",
      progress: 100,
      result: { id: "external-demo", status: "pending" },
      failedReason: null,
    });
    expect(JSON.stringify(completed)).not.toContain("privateField");
    expect(JSON.stringify(completed)).not.toMatch(/email|phone|address|title/i);
  });
});
