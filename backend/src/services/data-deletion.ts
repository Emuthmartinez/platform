/**
 * Service de solicitudes de eliminación de datos personales (GDPR/CCPA).
 * Sigue el mismo patrón que contact.ts: inserta la solicitud persistiendo el
 * HASH de IP (nunca la IP cruda), devuelve solo el id y expone DTOs sin
 * ip_hash en las listas.
 */
import { desc, eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { logDbFailure } from "@/lib/db-error";
import { purgeFailedSubmissionsByEmail } from "@/services/failed-submissions";
import { anonymizePledgesByContact } from "@/services/campaign/anonymize";
import { incidentOwnership } from "@/tenant/ownership";
import type { TenantScope } from "@/tenant/scope";

const { dataDeletionRequests } = schema;

/** Solicitud expuesta al admin. Allowlist: NUNCA incluye ip_hash. */
export interface DeletionRequestDTO {
  id: string;
  name: string;
  email: string;
  details: string | null;
  status: string;
  createdAt: number;
  updatedAt: number;
}

export async function createDeletionRequest(input: {
  name: string;
  email: string;
  details?: string | null;
  ipHash?: string | null;
}, scope: TenantScope): Promise<{ id: string }> {
  const id = crypto.randomUUID();
  const now = Date.now();
  const db = await getDb();
  await db.insert(dataDeletionRequests).values({
    id,
    name: input.name,
    email: input.email,
    details: input.details ?? null,
    status: "pending",
    ipHash: input.ipHash ?? null,
    createdAt: now,
    updatedAt: now,
    ...incidentOwnership(scope),
  });
  return { id };
}

/** Lista de solicitudes para el panel admin (DTO allowlist, sin ip_hash). */
export async function listDeletionRequests(): Promise<DeletionRequestDTO[]> {
  const db = await getDb();
  const rows = await db
    .select({
      id: dataDeletionRequests.id,
      name: dataDeletionRequests.name,
      email: dataDeletionRequests.email,
      details: dataDeletionRequests.details,
      status: dataDeletionRequests.status,
      createdAt: dataDeletionRequests.createdAt,
      updatedAt: dataDeletionRequests.updatedAt,
    })
    .from(dataDeletionRequests)
    .orderBy(desc(dataDeletionRequests.createdAt));
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    email: r.email,
    details: r.details,
    status: r.status,
    createdAt: Number(r.createdAt),
    updatedAt: Number(r.updatedAt),
  }));
}

/** Estados válidos de una solicitud de supresión. */
export const DELETION_REQUEST_STATUSES = ["pending", "resolved", "rejected"] as const;
export type DeletionRequestStatus = (typeof DELETION_REQUEST_STATUSES)[number];

/**
 * Cambia el estado de una solicitud (panel admin, Ley 1581). Devuelve el DTO
 * actualizado (con cuántos envíos fallidos se purgaron) o null si no existe.
 * La decisión queda además en audit_log (lo escribe el router con writeAudit).
 *
 * Al pasar a "resolved", además purga los `failed_submissions` cuyo payload
 * contiene el email del solicitante: la supresión debe alcanzar también los
 * envíos que nunca llegaron a su tabla destino (ver
 * services/failed-submissions.ts). El purge es best-effort: si falla, la
 * resolución NO se revierte (no hay transacciones en Workers) — se loguea y
 * el drenaje de retención acaba borrando esas filas igualmente.
 */
export async function updateDeletionRequestStatus(
  id: string,
  status: DeletionRequestStatus,
): Promise<{ item: DeletionRequestDTO; purgedFailedSubmissions: number } | null> {
  const db = await getDb();
  const rows = await db
    .update(dataDeletionRequests)
    .set({ status, updatedAt: Date.now() })
    .where(eq(dataDeletionRequests.id, id))
    .returning({
      id: dataDeletionRequests.id,
      name: dataDeletionRequests.name,
      email: dataDeletionRequests.email,
      details: dataDeletionRequests.details,
      status: dataDeletionRequests.status,
      createdAt: dataDeletionRequests.createdAt,
      updatedAt: dataDeletionRequests.updatedAt,
    });
  const row = rows[0];
  if (!row) return null;

  let purgedFailedSubmissions = 0;
  if (status === "resolved") {
    try {
      purgedFailedSubmissions = await purgeFailedSubmissionsByEmail(row.email);
    } catch (err) {
      // Best-effort: la resolución ya está escrita y no se revierte. La
      // retención (cron) acaba purgando estas filas aunque esto falle.
      logDbFailure("data-deletion.purge-failed-submissions", err);
    }
    try {
      // Los compromisos de la campaña se anonimizan, no se borran: la cifra
      // pública ya contó ese material (ver services/campaign/anonymize.ts).
      await anonymizePledgesByContact(row.email);
    } catch (err) {
      logDbFailure("data-deletion.anonymize-pledges", err);
    }
  }

  return {
    item: {
      id: row.id,
      name: row.name,
      email: row.email,
      details: row.details,
      status: row.status,
      createdAt: Number(row.createdAt),
      updatedAt: Number(row.updatedAt),
    },
    purgedFailedSubmissions,
  };
}
