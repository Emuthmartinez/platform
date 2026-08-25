import { beforeEach, describe, expect, it, vi } from "vitest";

const upstreamFetch = vi.fn();

vi.mock("../../_shared/upstream", async () => {
  const actual = await vi.importActual<typeof import("../../_shared/upstream")>(
    "../../_shared/upstream",
  );
  return {
    ...actual,
    apiUrl: (path: string) => `https://platform.test/api/platform${path}`,
    platformApiFetch: () => upstreamFetch,
  };
});

describe("ops login BFF", () => {
  beforeEach(() => upstreamFetch.mockReset());

  it("stores the platform token only in an httpOnly cookie", async () => {
    upstreamFetch.mockResolvedValue(
      Response.json({ ok: true, token: "signed-platform-token" }),
    );
    const { POST } = await import("./route");
    const response = await POST(
      new Request("https://ops.test/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ email: "operator@example.org", password: "synthetic" }),
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(response.headers.get("set-cookie")).toContain("mallanet_ops_bff_session=signed-platform-token");
    expect(response.headers.get("set-cookie")).toContain("HttpOnly");
  });

  it("does not set a cookie when upstream authentication fails", async () => {
    upstreamFetch.mockResolvedValue(
      Response.json({ error: "Invalid platform operator credentials." }, { status: 401 }),
    );
    const { POST } = await import("./route");
    const response = await POST(
      new Request("https://ops.test/api/auth/login", { method: "POST", body: "{}" }),
    );

    expect(response.status).toBe(401);
    expect(response.headers.get("set-cookie")).toBeNull();
  });
});
