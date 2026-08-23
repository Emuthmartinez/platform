/**
 * Compromisos de donación de material.
 *
 * Un compromiso NO es una donación: es la intención de llevar material a un
 * punto. Se convierte en donación cuando el responsable del punto confirma la
 * entrega (services/campaign/receipts.ts). Los agregados públicos separan las
 * dos cosas siempre, porque prometer y entregar no son lo mismo y mezclarlas
 * sería exactamente el tipo de cifra inflada que esta campaña no se puede
 * permitir.
 */
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { materialPledges, type MaterialLine } from "@/db/campaign-schema";
import { materialLabel, materialUnit } from "@/lib/campaign-materials";
import { persistPhotoDataUrl } from "@/lib/r2";
import { incidentOwnership } from "@/tenant/ownership";
import type { TenantScope } from "@/tenant/scope";
import { normalizePledgeCode, PLEDGE_CODE_LENGTH, randomPledgeCode } from "./pledge-code";

const CODE_MAX_ATTEMPTS = 5;

export interface PledgeInput {
  siteId: string | null;
  donorName: string;
  donorContact: string;
  publicAlias: string | null;
  items: MaterialLine[];
  expectedAt: number | null;
  note: string;
  photo: string | null;
  source: string;
  ipHash: string | null;
}

export interface PublicCertificate {
  code: string;
  status: string;
  alias: string | null;
  items: Array<MaterialLine & { label: string; unitLabel: string }>;
  createdAt: number;
  confirmedAt: number | null;
  siteId: string | null;
}

/**
 * El código es la credencial del certificado, así que su espacio (31^10) tiene
 * que hacer inviable adivinarlo. La colisión se comprueba igualmente, con el
 * mismo bucle acotado que usa services/volunteers.ts.
 */
async function generateUniqueCode(): Promise<string> {
  const db = await getDb();
  for (let attempt = 0; attempt < CODE_MAX_ATTEMPTS; attempt += 1) {
    const code = randomPledgeCode();
    const clash = await db
      .select({ id: materialPledges.id })
      .from(materialPledges)
      .where(eq(materialPledges.code, code))
      .limit(1);
    if (clash.length === 0) return code;
  }
  throw new Error("campaign: no se pudo generar un código único de compromiso");
}

export async function createPledge(
  input: PledgeInput,
  scope: TenantScope,
): Promise<{ id: string; code: string }> {
  const db = await getDb();
  const id = crypto.randomUUID();
  const code = await generateUniqueCode();
  const now = Date.now();
  // La foto se sube ANTES del insert para que la fila nunca quede apuntando a
  // un objeto que no existe. Si R2 no está configurado, esto devuelve el
  // data-URL tal cual y se guarda en la columna (ver lib/r2.ts).
  const photo = input.photo
    ? (await persistPhotoDataUrl(input.photo, "material_pledges", id)).stored
    : null;
  await db.insert(materialPledges).values({
    id,
    code,
    siteId: input.siteId,
    donorName: input.donorName,
    donorContact: input.donorContact,
    publicAlias: input.publicAlias,
    items: input.items,
    status: "pledged",
    expectedAt: input.expectedAt,
    note: input.note,
    photo,
    source: input.source,
    ipHash: input.ipHash,
    createdAt: now,
    updatedAt: now,
    ...incidentOwnership(scope),
  });
  return { id, code };
}

/**
 * Proyección del certificado. NO devuelve el nombre ni el contacto de quien
 * dona: solo el alias, y solo si esa persona marcó la casilla de aparecer en
 * público. Quien tiene el código ya sabe quién es; cualquiera que lo intercepte
 * no debería enterarse.
 */
export async function getCertificate(rawCode: string): Promise<PublicCertificate | null> {
  const code = normalizePledgeCode(rawCode);
  if (code.length !== PLEDGE_CODE_LENGTH) return null;
  const db = await getDb();
  const rows = await db
    .select({
      code: materialPledges.code,
      status: materialPledges.status,
      alias: materialPledges.publicAlias,
      items: materialPledges.items,
      createdAt: materialPledges.createdAt,
      updatedAt: materialPledges.updatedAt,
      siteId: materialPledges.siteId,
    })
    .from(materialPledges)
    .where(eq(materialPledges.code, code))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  const confirmed = row.status === "received" || row.status === "partial";
  return {
    code: row.code,
    status: row.status,
    alias: row.alias ?? null,
    items: (row.items ?? []).map((item) => ({
      ...item,
      label: materialLabel(item.material),
      unitLabel: materialUnit(item.material),
    })),
    createdAt: row.createdAt,
    confirmedAt: confirmed ? (row.updatedAt ?? null) : null,
    siteId: row.siteId ?? null,
  };
}

export { normalizePledgeCode, PLEDGE_CODE_LENGTH };
