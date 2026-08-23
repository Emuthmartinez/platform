/**
 * CRUD de puntos de recolección para el panel. La lectura pública vive en
 * sites.ts y filtra los cerrados; aquí se ven todos, porque cerrar un punto es
 * justo una de las cosas que se administran.
 */
import { desc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { campaignSites, DEFAULT_CAMPAIGN } from "@/db/campaign-schema";
import { incidentOwnership } from "@/tenant/ownership";
import type { TenantScope } from "@/tenant/scope";

export interface SiteDTO {
  id: string;
  name: string;
  city: string;
  address: string;
  schedule: string;
  publicContact: string;
  accepts: string[];
  status: string;
  note: string;
  lat: number | null;
  lng: number | null;
  createdAt: number;
}

export interface SiteInput {
  name: string;
  city: string;
  address?: string;
  schedule?: string;
  publicContact?: string;
  accepts?: string[];
  status?: string;
  note?: string;
  lat?: number | null;
  lng?: number | null;
}

const columns = {
  id: campaignSites.id,
  name: campaignSites.name,
  city: campaignSites.city,
  address: campaignSites.address,
  schedule: campaignSites.schedule,
  publicContact: campaignSites.publicContact,
  accepts: campaignSites.accepts,
  status: campaignSites.status,
  note: campaignSites.note,
  lat: campaignSites.lat,
  lng: campaignSites.lng,
  createdAt: campaignSites.createdAt,
};

function toDTO(row: Record<string, unknown>): SiteDTO {
  return {
    id: String(row.id),
    name: String(row.name),
    city: String(row.city),
    address: String(row.address ?? ""),
    schedule: String(row.schedule ?? ""),
    publicContact: String(row.publicContact ?? ""),
    accepts: Array.isArray(row.accepts) ? (row.accepts as string[]) : [],
    status: String(row.status ?? "active"),
    note: String(row.note ?? ""),
    lat: row.lat === null || row.lat === undefined ? null : Number(row.lat),
    lng: row.lng === null || row.lng === undefined ? null : Number(row.lng),
    createdAt: Number(row.createdAt ?? 0),
  };
}

export async function listSites(): Promise<SiteDTO[]> {
  const db = await getDb();
  const rows = await db.select(columns).from(campaignSites).orderBy(desc(campaignSites.createdAt)).limit(500);
  return rows.map(toDTO);
}

export async function getSite(id: string): Promise<SiteDTO | null> {
  const db = await getDb();
  const rows = await db.select(columns).from(campaignSites).where(eq(campaignSites.id, id)).limit(1);
  return rows[0] ? toDTO(rows[0]) : null;
}

export async function createSite(input: SiteInput, scope: TenantScope): Promise<SiteDTO> {
  const db = await getDb();
  const id = crypto.randomUUID();
  const now = Date.now();
  await db.insert(campaignSites).values({
    id,
    campaign: DEFAULT_CAMPAIGN,
    name: input.name,
    city: input.city,
    address: input.address ?? "",
    schedule: input.schedule ?? "",
    publicContact: input.publicContact ?? "",
    accepts: input.accepts ?? [],
    status: input.status ?? "active",
    note: input.note ?? "",
    lat: input.lat ?? null,
    lng: input.lng ?? null,
    createdAt: now,
    updatedAt: now,
    ...incidentOwnership(scope),
  });
  const created = await getSite(id);
  if (!created) throw new Error("No se pudo leer el punto recién creado.");
  return created;
}

export async function updateSite(id: string, input: Partial<SiteInput>): Promise<SiteDTO | null> {
  const db = await getDb();
  const patch: Record<string, unknown> = { updatedAt: Date.now() };
  for (const key of ["name", "city", "address", "schedule", "publicContact", "status", "note", "accepts", "lat", "lng"] as const) {
    if (input[key] !== undefined) patch[key] = input[key];
  }
  const rows = await db
    .update(campaignSites)
    .set(patch)
    .where(eq(campaignSites.id, id))
    .returning({ id: campaignSites.id });
  return rows.length > 0 ? getSite(id) : null;
}

export async function removeSite(id: string): Promise<boolean> {
  const db = await getDb();
  const rows = await db.delete(campaignSites).where(eq(campaignSites.id, id)).returning({ id: campaignSites.id });
  return rows.length > 0;
}
