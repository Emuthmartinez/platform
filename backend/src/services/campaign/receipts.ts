/**
 * Recepción de material en el punto: el paso que convierte un compromiso en
 * una donación real y en un certificado válido.
 *
 * Sin `db.transaction`: en Workers no existe. El compromiso se reclama con un
 * UPDATE condicional atómico (solo pasa de 'pledged' a confirmado quien gane
 * la carrera), y si la inserción del recibo falla después, se compensa
 * devolviendo el compromiso a 'pledged'. Es el mismo idioma que
 * services/patient-imports/apply.ts.
 */
import { and, desc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import {
  materialPledges,
  materialReceipts,
  type MaterialLine,
} from "@/db/campaign-schema";
import { persistPhotoDataUrl } from "@/lib/r2";
import { incidentOwnership } from "@/tenant/ownership";
import type { TenantScope } from "@/tenant/scope";
import { receiptStatus } from "./receipt-status";

export interface ReceiptInput {
  siteId: string;
  stewardId: string;
  pledgeCode: string | null;
  items: MaterialLine[];
  note: string;
  photo: string | null;
}

export type ReceiptOutcome =
  | { ok: true; receiptId: string; pledgeCode: string | null; status: string }
  | { ok: false; reason: "unknown_code" | "already_confirmed" };

export async function registerReceipt(input: ReceiptInput, scope: TenantScope): Promise<ReceiptOutcome> {
  const db = await getDb();
  const now = Date.now();
  const receiptId = crypto.randomUUID();
  const photo = input.photo
    ? (await persistPhotoDataUrl(input.photo, "material_receipts", receiptId)).stored
    : null;

  if (!input.pledgeCode) {
    await db.insert(materialReceipts).values({
      id: receiptId,
      pledgeId: null,
      siteId: input.siteId,
      stewardId: input.stewardId,
      items: input.items,
      note: input.note,
      photo,
      receivedAt: now,
      createdAt: now,
      ...incidentOwnership(scope),
    });
    return { ok: true, receiptId, pledgeCode: null, status: "walk_in" };
  }

  const existing = await db
    .select({ id: materialPledges.id, items: materialPledges.items, status: materialPledges.status })
    .from(materialPledges)
    .where(eq(materialPledges.code, input.pledgeCode))
    .limit(1);
  const pledge = existing[0];
  if (!pledge) return { ok: false, reason: "unknown_code" };

  const status = receiptStatus(pledge.items ?? [], input.items);

  const claimed = await db
    .update(materialPledges)
    .set({ status, siteId: input.siteId, updatedAt: now })
    .where(and(eq(materialPledges.id, pledge.id), eq(materialPledges.status, "pledged")))
    .returning({ id: materialPledges.id });
  if (claimed.length === 0) return { ok: false, reason: "already_confirmed" };

  try {
    await db.insert(materialReceipts).values({
      id: receiptId,
      pledgeId: pledge.id,
      siteId: input.siteId,
      stewardId: input.stewardId,
      items: input.items,
      note: input.note,
      photo,
      receivedAt: now,
      createdAt: now,
      ...incidentOwnership(scope),
    });
  } catch (err) {
    await db
      .update(materialPledges)
      .set({ status: "pledged", updatedAt: Date.now() })
      .where(eq(materialPledges.id, pledge.id));
    throw err;
  }

  return { ok: true, receiptId, pledgeCode: input.pledgeCode, status };
}

/** Lo que el punto espera recibir: compromisos aún sin confirmar dirigidos ahí. */
export async function listPendingForSite(siteId: string, limit = 100) {
  const db = await getDb();
  return db
    .select({
      code: materialPledges.code,
      donorName: materialPledges.donorName,
      items: materialPledges.items,
      expectedAt: materialPledges.expectedAt,
      createdAt: materialPledges.createdAt,
    })
    .from(materialPledges)
    .where(and(eq(materialPledges.siteId, siteId), eq(materialPledges.status, "pledged")))
    .orderBy(desc(materialPledges.createdAt))
    .limit(limit);
}

/** Últimas entregas confirmadas en el punto, para que el responsable se vea el trabajo hecho. */
export async function listRecentReceipts(siteId: string, limit = 30) {
  const db = await getDb();
  return db
    .select({
      id: materialReceipts.id,
      items: materialReceipts.items,
      note: materialReceipts.note,
      receivedAt: materialReceipts.receivedAt,
    })
    .from(materialReceipts)
    .where(eq(materialReceipts.siteId, siteId))
    .orderBy(desc(materialReceipts.receivedAt))
    .limit(limit);
}
