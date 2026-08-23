import { afterEach, describe, expect, it, vi } from "vitest";
import "../helpers";
import {
  checkRateLimit,
  registerWorkerRateLimiter,
  resetRateLimitStateForTests,
} from "@/lib/rate-limit";

const originalDisabled = process.env.RATE_LIMIT_DISABLED;

afterEach(() => {
  resetRateLimitStateForTests();
  process.env.RATE_LIMIT_DISABLED = originalDisabled;
});

describe("Cloudflare rate limit binding", () => {
  it("rejects before the per-isolate fallback when the shared ceiling is exhausted", async () => {
    delete process.env.RATE_LIMIT_DISABLED;
    const limit = vi.fn().mockResolvedValue({ success: false });
    registerWorkerRateLimiter({ limit });
    await expect(
      checkRateLimit("scope:hashed-actor", { limit: 120 }, "flood:hashed-actor"),
    ).resolves.toBe(false);
    expect(limit).toHaveBeenCalledWith({ key: "flood:hashed-actor" });
  });
});
