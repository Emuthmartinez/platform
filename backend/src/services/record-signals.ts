/**
 * `record_status_signals` (U14, R24/R25/R26/AE4) — "señal, no verdad": una
 * transición de status que llega por un upsert externo (socio/sync, ver
 * `services/missing.ts:upsertExternalMissingBatch`) NUNCA pisa el status
 * guardado del registro. Queda aquí, pendiente, hasta que un revisor humano
 * la confirme o la descarte. Este archivo es el ÚNICO que lee/escribe
 * `record_status_signals`; `missing.ts` solo llama a `createStatusSignal`.
 *
 * SIN `db.transaction()` A PROPÓSITO (mismo criterio que el resto del módulo
 * de identidad: el driver HTTP de Neon en Workers no admite transacciones
 * interactivas). La concurrencia de "decidir una señal" usa el MISMO idioma
 * de CLAIM condicional que `services/person-links.ts` (`decideLink`): una
 * UPDATE atómica `WHERE status = 'pending'` es el punto de serialización —
 * el perdedor de la carrera recibe 0 filas y decide desde ahí (replay
 * idempotente o 409), nunca un SELECT-then-UPDATE con ventana. A diferencia
 * de `person_links` (que separa el claim de una fila `person_link_decisions`
 * aparte), aquí `decided_by`/`decided_at`/`decision_note` son columnas de la
 * MISMA fila — el claim UPDATE ya deja la decisión completa en un solo paso.
 */
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { conflict, notFound } from "@/lib/errors";
import { colombiaTenantScope } from "@/lib/colombia-tenant";
import { resolvePrn } from "@/services/person-records";
import { loadDisplayFields, type RecordDisplay } from "@/services/person-clusters";
import { incidentOwnership } from "@/tenant/ownership";
import type { TenantScope } from "@/tenant/scope";

const { recordStatusSignals } = schema;

// --------------------------------------------------------------- crear ---

export interface CreateStatusSignalInput {
  prn: string;
  /** Procedencia del claim — 'partner:<email>' | el `source` de un adaptador de feed. */
  source: string;
  claimedStatus: string;
  resolutionNote?: string | null;
  /** Solo 'status_report' hoy (KTD19: precursor de intake_items). */
  kind?: string;
  scope?: TenantScope;
}

/**
 * Inserta una señal pendiente, o (si ya hay una pendiente para el MISMO
 * (prn, kind, claimedStatus)) refresca su payload sin apilar una fila nueva —
 * `ON CONFLICT` sobre el índice parcial único `idx_record_status_signals_pending`
 * (infra/db/schema.ts). Idempotente por diseño: un socio que repite el mismo
 * re-sync (misma transición reclamada) nunca produce una segunda señal en
 * cola, solo actualiza `reported_at` dentro del payload.
 *
 * Best-effort (mismo contrato que `ensurePrn`/`enqueueMatcherSweep`): nunca
 * lanza. Se llama DESPUÉS de que el upsert externo ya escribió la fila fuente
 * — un fallo aquí no debe tumbar esa escritura ya confirmada.
 */
export async function createStatusSignal(input: CreateStatusSignalInput): Promise<void> {
  try {
    const db = getDb();
    const now = Date.now();
    const kind = input.kind ?? "status_report";
    const ownership = incidentOwnership(input.scope ?? colombiaTenantScope());
    const payload = JSON.stringify({
      resolutionNote: input.resolutionNote ?? null,
      reportedAt: now,
    });
    await db.execute(sql`
      INSERT INTO record_status_signals (id, prn, source, kind, claimed_status, payload, status, created_at, organization_id, incident_id)
      VALUES (${crypto.randomUUID()}, ${input.prn}, ${input.source}, ${kind}, ${input.claimedStatus}, ${payload}::jsonb, 'pending', ${now}, ${ownership.organizationId}, ${ownership.incidentId})
      ON CONFLICT (prn, kind, claimed_status) WHERE status = 'pending'
      DO UPDATE SET
        payload = EXCLUDED.payload,
        organization_id = COALESCE(record_status_signals.organization_id, EXCLUDED.organization_id),
        incident_id = COALESCE(record_status_signals.incident_id, EXCLUDED.incident_id)
    `);
  } catch (err) {
    console.error(
      `[record-signals] createStatusSignal best-effort falló para prn="${input.prn}" ` +
        `claimedStatus="${input.claimedStatus}":`,
      err,
    );
  }
}

// ------------------------------------------------------------- listar ---

export interface PendingSignalDTO {
  id: string;
  prn: string;
  source: string;
  kind: string;
  claimedStatus: string;
  /** Status guardado HOY en el registro fuente (para comparar contra claimedStatus en el panel). */
  storedStatus: string | null;
  payload: unknown;
  createdAt: number;
  /** Campos de presentación del registro (nombre/edad/población/cluster) — null si el PRN no resuelve. */
  record: RecordDisplay | null;
}

export interface ListPendingParams {
  /** Cursor keyset: continuar DESPUÉS de este (createdAt, id) — cola ordenada más-antigua-primero. */
  after?: { createdAt: number; id: string } | null;
  limit?: number;
}

/** Status guardado hoy en `missing_persons`, por PRN (solo `missing_report`
 *  tiene este concepto — hoy el ÚNICO tipo de registro que produce señales,
 *  ver `upsertExternalMissingBatch`). Batched: 2 queries totales, nunca N+1. */
async function loadStoredMissingStatus(prns: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (prns.length === 0) return out;
  const db = getDb();

  const refs = await db
    .select({ prn: schema.personRecords.prn, recordId: schema.personRecords.recordId })
    .from(schema.personRecords)
    .where(
      and(
        eq(schema.personRecords.recordType, "missing_report"),
        inArray(schema.personRecords.prn, prns),
      ),
    );
  if (refs.length === 0) return out;

  const ids = refs.map((r) => r.recordId);
  const rows = await db
    .select({ id: schema.missingPersons.id, status: schema.missingPersons.status })
    .from(schema.missingPersons)
    .where(inArray(schema.missingPersons.id, ids));
  const statusById = new Map(rows.map((r) => [r.id, r.status]));

  for (const ref of refs) {
    const status = statusById.get(ref.recordId);
    if (status) out.set(ref.prn, status);
  }
  return out;
}

/** Cola de señales PENDIENTES, más-antigua-primero (FIFO de revisión) —
 *  keyset por (created_at, id), nunca offset. Trae, por señal, los campos de
 *  presentación del registro (`loadDisplayFields`, que ya incluye clusterId
 *  si tiene uno vivo) + el status guardado hoy, para que el panel muestre
 *  "reclama X, hoy tiene Y" sin una llamada aparte por fila. */
export async function listPending(params: ListPendingParams = {}): Promise<PendingSignalDTO[]> {
  const db = getDb();
  const limit = Math.min(Math.max(params.limit ?? 50, 1), 200);

  const conditions = [eq(recordStatusSignals.status, "pending")];
  if (params.after) {
    conditions.push(
      sql`(${recordStatusSignals.createdAt}, ${recordStatusSignals.id}) > (${params.after.createdAt}, ${params.after.id})`,
    );
  }

  const rows = await db
    .select()
    .from(recordStatusSignals)
    .where(and(...conditions))
    .orderBy(asc(recordStatusSignals.createdAt), asc(recordStatusSignals.id))
    .limit(limit);
  if (rows.length === 0) return [];

  const prns = rows.map((r) => r.prn);
  const [displays, storedStatusByPrn] = await Promise.all([
    loadDisplayFields(prns),
    loadStoredMissingStatus(prns),
  ]);

  return rows.map((r) => ({
    id: r.id,
    prn: r.prn,
    source: r.source,
    kind: r.kind,
    claimedStatus: r.claimedStatus,
    storedStatus: storedStatusByPrn.get(r.prn) ?? null,
    payload: r.payload,
    createdAt: r.createdAt,
    record: displays.get(r.prn) ?? null,
  }));
}

// ------------------------------------------------------------- decidir ---

export interface SignalDTO {
  id: string;
  prn: string;
  source: string;
  kind: string;
  claimedStatus: string;
  payload: unknown;
  status: string;
  createdAt: number;
  decidedBy: string | null;
  decidedAt: number | null;
  decisionNote: string | null;
}

function toSignalDTO(row: typeof recordStatusSignals.$inferSelect): SignalDTO {
  return {
    id: row.id,
    prn: row.prn,
    source: row.source,
    kind: row.kind,
    claimedStatus: row.claimedStatus,
    payload: row.payload,
    status: row.status,
    createdAt: row.createdAt,
    decidedBy: row.decidedBy,
    decidedAt: row.decidedAt,
    decisionNote: row.decisionNote,
  };
}

type SignalRow = typeof recordStatusSignals.$inferSelect;

async function loadSignalRaw(signalId: string): Promise<SignalRow | null> {
  const db = getDb();
  const rows = await db
    .select()
    .from(recordStatusSignals)
    .where(eq(recordStatusSignals.id, signalId))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * CLAIM condicional: mueve `signalId` de 'pending' a `targetStatus` Y deja la
 * decisión completa (decidedBy/decidedAt/decisionNote) en el MISMO UPDATE
 * atómico — el punto de serialización de la carrera (ver docstring del
 * archivo).
 */
async function claimSignal(
  signalId: string,
  targetStatus: "confirmed" | "dismissed",
  actorId: string,
  note: string,
): Promise<SignalRow | null> {
  const db = getDb();
  const rows = await db
    .update(recordStatusSignals)
    .set({ status: targetStatus, decidedBy: actorId, decidedAt: Date.now(), decisionNote: note })
    .where(and(eq(recordStatusSignals.id, signalId), eq(recordStatusSignals.status, "pending")))
    .returning();
  return rows[0] ?? null;
}

const DECISION_TO_STATUS: Record<"confirmar" | "descartar", "confirmed" | "dismissed"> = {
  confirmar: "confirmed",
  descartar: "dismissed",
};

export interface DecideSignalInput {
  signalId: string;
  decision: "confirmar" | "descartar";
  /** "" si no se envió — el router exige no-vacío para 'descartar' vía zod. */
  note: string;
  actorId: string;
}

export interface DecideSignalResult {
  signal: SignalDTO;
  /** true = 200 de replay idempotente (mismo revisor, misma decisión); no se
   *  volvió a aplicar el claimedStatus al registro fuente. */
  idempotentReplay: boolean;
}

/**
 * Aplica `claimedStatus` al registro fuente por el camino AUDITADO existente
 * (nunca un UPDATE directo aquí — `record-signals.ts` no es dueño de
 * `missing_persons`). Import DINÁMICO de `services/missing.ts` a propósito:
 * `missing.ts` importa `createStatusSignal` de ESTE archivo a nivel de
 * módulo, así que un `import` estático aquí, en la dirección contraria,
 * sería un ciclo real en el momento de evaluación del módulo — mismo idioma
 * que `person-records.ts:runClusterInvariantChecks` documenta para su propio
 * ciclo con `person-links.ts`.
 *
 * Semántica de idempotencia (documentada a propósito, KTD18): si la
 * transición reclamada YA fue aplicada por otra vía (p.ej. un staff marcó a
 * mano "localizada" antes de que este confirm corriera), `markMissingFound`/
 * `restoreMissing` no encuentran la fila en el status de origen que esperan
 * (`WHERE status = 'active'` / `WHERE status = 'found'`) y devuelven
 * `null`/`false` sin lanzar — confirmar una transición ya aplicada es un
 * NO-OP armónico, nunca un error.
 */
async function applyClaimedStatus(signal: SignalRow): Promise<void> {
  const ref = await resolvePrn(signal.prn);
  if (!ref || ref.removedAt !== null) return; // PRN sin registro vivo: nada que aplicar.
  if (ref.recordType !== "missing_report") return; // KTD18: hoy solo missing_report produce señales.

  const { markMissingFound, restoreMissing } = await import("@/services/missing");
  const payload = (signal.payload ?? {}) as { resolutionNote?: string | null };

  if (signal.claimedStatus === "found") {
    // markMissingFound exige una nota no vacía (pensada para el formulario
    // público); una señal externa puede llegar sin resolutionNote. Fallback
    // determinista para que confirmar NUNCA falle por falta de nota, sin
    // duplicar la validación de markMissingFound aquí.
    const note = payload.resolutionNote?.trim() || `Confirmado vía señal externa (${signal.source}).`;
    await markMissingFound(ref.recordId, note, null);
  } else if (signal.claimedStatus === "active") {
    await restoreMissing(ref.recordId);
  }
  // Cualquier otro claimedStatus (no debería ocurrir hoy: missing.ts solo
  // reclama 'active'/'found') queda sin aplicar — defensivo, nunca lanza.
}

/**
 * Protocolo completo de decisión (R25/R26):
 *  1. (zod ya corrió en el router — nota obligatoria para 'descartar')
 *  2. CLAIM condicional (incluye decidedBy/decidedAt/decisionNote).
 *  3. 0 filas -> replay idempotente (mismo revisor+decisión) o 409.
 *  4. 'confirmar': aplica claimedStatus al registro fuente vía el camino
 *     auditado existente (markMissingFound/restoreMissing).
 *  5. (el router hace writeAudit — fuera de este service, igual que el resto
 *     del repo, ver person-links.ts).
 */
export async function decideSignal(input: DecideSignalInput): Promise<DecideSignalResult> {
  const targetStatus = DECISION_TO_STATUS[input.decision];

  const claimed = await claimSignal(input.signalId, targetStatus, input.actorId, input.note);
  if (!claimed) {
    const current = await loadSignalRaw(input.signalId);
    if (!current) throw notFound("Señal no encontrada.");
    if (current.status === targetStatus && current.decidedBy === input.actorId) {
      return { signal: toSignalDTO(current), idempotentReplay: true };
    }
    throw conflict(
      "Esta señal ya fue decidida por otro revisor o cambió de estado; recárgala e inténtalo de nuevo.",
    );
  }

  if (input.decision === "confirmar") {
    await applyClaimedStatus(claimed);
  }

  return { signal: toSignalDTO(claimed), idempotentReplay: false };
}
