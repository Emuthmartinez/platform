/**
 * BFF /api/admin/deployments/[hostname] — PATCH y DELETE.
 */
import type { NextResponse } from "next/server";
import { createAuthedEmergencyClient } from "../../../../../src/shared/http/authed-fetch";
import { json, mapApiError, unauthorized } from "../../../_shared/proxy";

export const dynamic = "force-dynamic";

export async function PATCH(
  request: Request,
  ctx: { params: Promise<{ hostname: string }> },
): Promise<NextResponse> {
  const client = createAuthedEmergencyClient(request);
  if (!client) return unauthorized();
  const { hostname } = await ctx.params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const result = await client.patch<unknown>(
    `/api/public/deployments/${encodeURIComponent(hostname)}`,
    body,
  );
  if (!result.ok) return mapApiError(result.error);
  return json(result.value, 200);
}

export async function DELETE(
  request: Request,
  ctx: { params: Promise<{ hostname: string }> },
): Promise<NextResponse> {
  const client = createAuthedEmergencyClient(request);
  if (!client) return unauthorized();
  const { hostname } = await ctx.params;

  const result = await client.delete<{ ok: boolean }>(
    `/api/public/deployments/${encodeURIComponent(hostname)}`,
  );
  if (!result.ok) return mapApiError(result.error);
  return json(result.value, 200);
}
