/**
 * Alta y baja de responsables de punto desde el panel.
 *
 * `create` devuelve el token EN CLARO una única vez, en la respuesta del 201.
 * No se puede volver a leer: la base solo guarda su sha256. Si alguien lo
 * pierde, se revoca ese responsable y se da de alta otro. Es deliberado — un
 * token recuperable en el panel es un token que acaba en una captura de
 * pantalla en un grupo de WhatsApp.
 */
import { desc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { campaignSiteStewards, campaignSites } from "@/db/campaign-schema";
import { createSteward, revokeSteward } from "./stewards";
import type { TenantScope } from "@/tenant/scope";

export interface StewardDTO {
  id: string;
  siteId: string;
  siteName: string | null;
  city: string | null;
  displayName: string;
  active: boolean;
  createdAt: number;
  token?: string;
}

const columns = {
  id: campaignSiteStewards.id,
  siteId: campaignSiteStewards.siteId,
  displayName: campaignSiteStewards.displayName,
  active: campaignSiteStewards.active,
  createdAt: campaignSiteStewards.createdAt,
  siteName: campaignSites.name,
  city: campaignSites.city,
};

function toDTO(row: Record<string, unknown>): StewardDTO {
  return {
    id: String(row.id),
    siteId: String(row.siteId),
    siteName: row.siteName ? String(row.siteName) : null,
    city: row.city ? String(row.city) : null,
    displayName: String(row.displayName),
    active: Boolean(row.active),
    createdAt: Number(row.createdAt ?? 0),
  };
}

export async function listStewards(): Promise<StewardDTO[]> {
  const db = await getDb();
  const rows = await db
    .select(columns)
    .from(campaignSiteStewards)
    .leftJoin(campaignSites, eq(campaignSites.id, campaignSiteStewards.siteId))
    .orderBy(desc(campaignSiteStewards.createdAt))
    .limit(300);
  return rows.map(toDTO);
}

export async function getSteward(id: string): Promise<StewardDTO | null> {
  const db = await getDb();
  const rows = await db
    .select(columns)
    .from(campaignSiteStewards)
    .leftJoin(campaignSites, eq(campaignSites.id, campaignSiteStewards.siteId))
    .where(eq(campaignSiteStewards.id, id))
    .limit(1);
  return rows[0] ? toDTO(rows[0]) : null;
}

export async function addSteward(input: {
  siteId: string;
  displayName: string;
}, scope: TenantScope): Promise<StewardDTO> {
  const { id, token } = await createSteward(input, scope);
  const created = await getSteward(id);
  if (!created) throw new Error("No se pudo leer el responsable recién creado.");
  return { ...created, token };
}

export async function deactivateSteward(id: string): Promise<boolean> {
  return revokeSteward(id);
}
