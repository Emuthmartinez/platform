import { NextResponse } from "next/server";
import { apiUrl, platformApiFetch, sessionCookie } from "../../_shared/upstream";

export async function POST(request: Request) {
  const assertion = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!assertion) {
    return NextResponse.json(
      { error: "Cloudflare Access assertion required." },
      { status: 401, headers: { "Cache-Control": "no-store" } },
    );
  }
  const upstream = await platformApiFetch()(apiUrl("/auth/access"), {
    method: "POST",
    headers: { "Cf-Access-Jwt-Assertion": assertion, Accept: "application/json" },
    cache: "no-store",
    signal: AbortSignal.timeout(5_000),
  });
  const payload = (await upstream.json().catch(() => ({}))) as { token?: string; error?: string };
  if (!upstream.ok || !payload.token) {
    return NextResponse.json(
      { error: payload.error ?? "Platform Access authentication failed." },
      { status: upstream.status, headers: { "Cache-Control": "no-store" } },
    );
  }
  const response = NextResponse.json({ ok: true });
  response.cookies.set(sessionCookie.name, payload.token, sessionCookie.options);
  response.headers.set("Cache-Control", "no-store");
  return response;
}
