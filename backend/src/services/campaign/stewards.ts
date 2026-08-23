/**
 * Responsables de punto: quien puede confirmar que el material llegó.
 *
 * Mismo trato que el POC de hospital (middleware/supply-auth.ts): la base
 * guarda el sha256 del token, nunca el token. Se emite una vez desde el panel
 * y se entrega por un canal privado; si se pierde, se revoca y se emite otro.
 */
import { createHash } from "crypto";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { campaignSiteStewards, campaignSites } from "@/db/campaign-schema";
import { incidentOwnership } from "@/tenant/ownership";
import type { TenantScope } from "@/tenant/scope";

export interface StewardIdentity {
  id: string;
  siteId: string;
  siteName: string;
  city: string;
  displayName: string;
}

export function hashStewardToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function generateStewardToken(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function findStewardByToken(token: string): Promise<StewardIdentity | null> {
  const clean = token.trim();
  if (clean.length < 16) return null;
  const db = await getDb();
  const rows = await db
    .select({
      id: campaignSiteStewards.id,
      siteId: campaignSiteStewards.siteId,
      displayName: campaignSiteStewards.displayName,
      siteName: campaignSites.name,
      city: campaignSites.city,
    })
    .from(campaignSiteStewards)
    .innerJoin(campaignSites, eq(campaignSites.id, campaignSiteStewards.siteId))
    .where(
      and(
        eq(campaignSiteStewards.active, true),
        eq(campaignSiteStewards.accessTokenHash, hashStewardToken(clean)),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    siteId: row.siteId,
    siteName: row.siteName,
    city: row.city,
    displayName: row.displayName,
  };
}

/**
 * Alta de responsable. Devuelve el token EN CLARO una sola vez: es lo único
 * que se puede entregar a la persona, y no se puede volver a leer después.
 */
export async function createSteward(input: {
  siteId: string;
  displayName: string;
}, scope: TenantScope): Promise<{ id: string; token: string }> {
  const db = await getDb();
  const id = crypto.randomUUID();
  const token = generateStewardToken();
  const now = Date.now();
  await db.insert(campaignSiteStewards).values({
    id,
    siteId: input.siteId,
    displayName: input.displayName,
    accessTokenHash: hashStewardToken(token),
    active: true,
    createdAt: now,
    updatedAt: now,
    ...incidentOwnership(scope),
  });
  return { id, token };
}

export async function revokeSteward(id: string): Promise<boolean> {
  const db = await getDb();
  const rows = await db
    .update(campaignSiteStewards)
    .set({ active: false, updatedAt: Date.now() })
    .where(and(eq(campaignSiteStewards.id, id), eq(campaignSiteStewards.active, true)))
    .returning({ id: campaignSiteStewards.id });
  return rows.length > 0;
}
