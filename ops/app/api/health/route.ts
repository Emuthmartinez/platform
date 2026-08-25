import { apiUrl, platformApiFetch } from "../_shared/upstream";

export async function GET() {
  try {
    const upstream = await platformApiFetch()(apiUrl("/readyz"), {
      headers: { Accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(3_000),
    });
    if (!upstream.ok) throw new Error(`platform readiness returned ${upstream.status}`);
    return Response.json(
      { ok: true, service: "mallanet-platform-ops", platformApi: "ready" },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return Response.json(
      { ok: false, service: "mallanet-platform-ops", platformApi: "unavailable" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
