/**
 * BFF /api/admin/deployments — GET catálogo y POST crear.
 * El backend gatea deployment:manage (solo superadmin).
 */
import type { NextResponse } from "next/server";
import { createAuthedEmergencyClient } from "../../../../src/shared/http/authed-fetch";
import { json, mapApiError, unauthorized } from "../../_shared/proxy";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<NextResponse> {
  const client = createAuthedEmergencyClient(request);
  if (!client) return unauthorized();

  const result = await client.get<unknown>("/api/public/deployments");
  if (!result.ok) return mapApiError(result.error);
  return json(result.value, 200);
}

export async function POST(request: Request): Promise<NextResponse> {
  const client = createAuthedEmergencyClient(request);
  if (!client) return unauthorized();

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const result = await client.post<unknown>("/api/public/deployments", body);
  if (!result.ok) return mapApiError(result.error);
  return json(result.value, 201);
}
