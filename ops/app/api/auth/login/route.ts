import { NextResponse } from "next/server";
import { apiUrl, platformApiFetch, sessionCookie } from "../../_shared/upstream";

export async function POST(request: Request) {
  const body = await request.text();
  const upstream = await platformApiFetch()(apiUrl("/auth/login"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
    cache: "no-store",
    signal: AbortSignal.timeout(5_000),
  });
  const payload = (await upstream.json().catch(() => ({}))) as { token?: string; error?: string };
  if (!upstream.ok || !payload.token) {
    return NextResponse.json(
      { error: payload.error ?? "Platform authentication failed." },
      { status: upstream.status, headers: { "Cache-Control": "no-store" } },
    );
  }
  const response = NextResponse.json({ ok: true });
  response.cookies.set(sessionCookie.name, payload.token, sessionCookie.options);
  response.headers.set("Cache-Control", "no-store");
  return response;
}
