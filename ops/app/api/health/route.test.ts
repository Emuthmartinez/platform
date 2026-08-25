import { beforeEach, describe, expect, it, vi } from "vitest";

const upstreamFetch = vi.fn();

vi.mock("../_shared/upstream", () => ({
  apiUrl: (path: string) => `https://platform.test/api/platform${path}`,
  platformApiFetch: () => upstreamFetch,
}));

describe("ops health route", () => {
  beforeEach(() => upstreamFetch.mockReset());

  it("reports ready only when the platform API is ready", async () => {
    upstreamFetch.mockResolvedValue(new Response(null, { status: 200 }));
    const { GET } = await import("./route");
    const response = await GET();

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, platformApi: "ready" });
    expect(upstreamFetch).toHaveBeenCalledWith(
      "https://platform.test/api/platform/readyz",
      expect.objectContaining({ cache: "no-store" }),
    );
  });

  it("returns 503 when the platform API is unavailable", async () => {
    upstreamFetch.mockResolvedValue(new Response(null, { status: 503 }));
    const { GET } = await import("./route");
    const response = await GET();

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ ok: false, platformApi: "unavailable" });
  });
});
