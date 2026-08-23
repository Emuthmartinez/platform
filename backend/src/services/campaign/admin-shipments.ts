/**
 * Lotes que salen de un punto hacia la zona afectada.
 *
 * Un lote es la parte de la trazabilidad que la gente puede comprobar: qué
 * salió, de dónde, cuándo y hacia dónde. El código del lote es público a
 * propósito, para poder citarlo en una publicación o en una foto del camión.
 */
import { desc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { materialShipments, DEFAULT_CAMPAIGN, type MaterialLine } from "@/db/campaign-schema";
import { incidentOwnership } from "@/tenant/ownership";
import type { TenantScope } from "@/tenant/scope";

export interface ShipmentDTO {
  id: string;
  code: string;
  originCity: string;
  destName: string;
  items: MaterialLine[];
  status: string;
  carrierNote: string;
  departedAt: number | null;
  arrivedAt: number | null;
  createdAt: number;
}

export interface ShipmentInput {
  originSiteId?: string | null;
  originCity: string;
  destName: string;
  items: MaterialLine[];
  status?: string;
  carrierNote?: string;
  departedAt?: number | null;
  arrivedAt?: number | null;
}

const columns = {
  id: materialShipments.id,
  code: materialShipments.code,
  originCity: materialShipments.originCity,
  destName: materialShipments.destName,
  items: materialShipments.items,
  status: materialShipments.status,
  carrierNote: materialShipments.carrierNote,
  departedAt: materialShipments.departedAt,
  arrivedAt: materialShipments.arrivedAt,
  createdAt: materialShipments.createdAt,
};

function toDTO(row: Record<string, unknown>): ShipmentDTO {
  return {
    id: String(row.id),
    code: String(row.code),
    originCity: String(row.originCity ?? ""),
    destName: String(row.destName),
    items: Array.isArray(row.items) ? (row.items as MaterialLine[]) : [],
    status: String(row.status ?? "loading"),
    carrierNote: String(row.carrierNote ?? ""),
    departedAt: row.departedAt === null || row.departedAt === undefined ? null : Number(row.departedAt),
    arrivedAt: row.arrivedAt === null || row.arrivedAt === undefined ? null : Number(row.arrivedAt),
    createdAt: Number(row.createdAt ?? 0),
  };
}

function shipmentCode(): string {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  const suffix = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();
  return `LOTE-${suffix}`;
}

export async function listShipments(): Promise<ShipmentDTO[]> {
  const db = await getDb();
  const rows = await db
    .select(columns)
    .from(materialShipments)
    .orderBy(desc(materialShipments.createdAt))
    .limit(300);
  return rows.map(toDTO);
}

export async function getShipment(id: string): Promise<ShipmentDTO | null> {
  const db = await getDb();
  const rows = await db.select(columns).from(materialShipments).where(eq(materialShipments.id, id)).limit(1);
  return rows[0] ? toDTO(rows[0]) : null;
}

export async function createShipment(input: ShipmentInput, scope: TenantScope): Promise<ShipmentDTO> {
  const db = await getDb();
  const id = crypto.randomUUID();
  const now = Date.now();
  await db.insert(materialShipments).values({
    id,
    campaign: DEFAULT_CAMPAIGN,
    code: shipmentCode(),
    originSiteId: input.originSiteId ?? null,
    originCity: input.originCity,
    destName: input.destName,
    items: input.items,
    status: input.status ?? "loading",
    carrierNote: input.carrierNote ?? "",
    departedAt: input.departedAt ?? null,
    arrivedAt: input.arrivedAt ?? null,
    createdAt: now,
    updatedAt: now,
    ...incidentOwnership(scope),
  });
  const created = await getShipment(id);
  if (!created) throw new Error("No se pudo leer el lote recién creado.");
  return created;
}

export async function updateShipment(
  id: string,
  input: Partial<ShipmentInput>,
): Promise<ShipmentDTO | null> {
  const db = await getDb();
  const patch: Record<string, unknown> = { updatedAt: Date.now() };
  for (const key of ["originCity", "destName", "items", "status", "carrierNote", "departedAt", "arrivedAt"] as const) {
    if (input[key] !== undefined) patch[key] = input[key];
  }
  const rows = await db
    .update(materialShipments)
    .set(patch)
    .where(eq(materialShipments.id, id))
    .returning({ id: materialShipments.id });
  return rows.length > 0 ? getShipment(id) : null;
}

export async function removeShipment(id: string): Promise<boolean> {
  const db = await getDb();
  const rows = await db
    .delete(materialShipments)
    .where(eq(materialShipments.id, id))
    .returning({ id: materialShipments.id });
  return rows.length > 0;
}
