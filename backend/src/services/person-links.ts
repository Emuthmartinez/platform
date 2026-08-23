/**
 * Motor de decisiones sobre `person_links` (U9): confirmar/rechazar/marcar
 * inseguro un vínculo propuesto (R12), proponer un vínculo a mano (R16),
 * deshacer una fusión (unmerge, R15), y las tres comprobaciones de
 * invariante de KTD8 que `services/person-records.ts` engancha en su cron.
 *
 * SIN `db.transaction()` A PROPÓSITO (mismo criterio que el resto de este
 * módulo de identidad: el driver HTTP de Neon en Workers no admite
 * transacciones interactivas). La concurrencia de "decidir un vínculo" se
 * resuelve con el mismo idioma de CLAIM condicional que
 * `services/patient-imports/rows.ts` (`editImportRow`) y `apply.ts`: una
 * UPDATE atómica `WHERE status IN (...)` es el punto de serialización — el
 * perdedor de la carrera recibe 0 filas y decide desde ahí (replay
 * idempotente o 409), nunca un SELECT-then-UPDATE con ventana.
 *
 * `orderPair`/`EvidenceClass`/`evidenceClassRank` se REUTILIZAN de
 * `services/matcher/propose.ts` — este archivo NUNCA duplica esa lógica
 * (KTD-U9 lo pide explícito: "import orderPair — do NOT duplicate").
 */
import { randomUUID } from "crypto";
import { and, desc, eq, inArray, or, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { HttpError, badRequest, conflict, notFound } from "@/lib/errors";
import { normalizePrn } from "@/lib/prn";
import { resolvePrn, enqueueMatcherSweep } from "@/services/person-records";
import {
  recomputeClusterFor,
  isAnchoredMerge,
  loadDisplayFields,
  confirmedComponent,
  liveClusterOf,
  liveMembersOf,
  type RecordDisplay,
  type DecisionHistoryEntryDTO,
} from "@/services/person-clusters";
import { orderPair, evidenceClassRank, type EvidenceClass } from "@/services/matcher/propose";
import { colombiaTenantScope } from "@/lib/colombia-tenant";
import { incidentOwnership, tenantScopeFromIds } from "@/tenant/ownership";

const { personLinks, personLinkDecisions, personClusters } = schema;

/** Mismo helper de una línea que el resto del módulo de identidad — ver
 *  person-clusters.ts para la nota completa sobre por qué no se comparte. */
function execRows<T>(result: unknown): T[] {
  return (Array.isArray(result) ? result : (result as { rows: T[] }).rows) as T[];
}

// ------------------------------------------------------------------ DTOs ---

export interface PersonLinkDTO {
  id: string;
  prnA: string;
  prnB: string;
  status: string;
  score: number | null;
  evidence: unknown;
  evidenceClass: string;
  method: string;
  matcherVersion: string | null;
  proposedAt: number;
}

function toLinkDTO(row: typeof personLinks.$inferSelect): PersonLinkDTO {
  return {
    id: row.id,
    prnA: row.prnA,
    prnB: row.prnB,
    status: row.status,
    score: row.score,
    evidence: row.evidence,
    evidenceClass: row.evidenceClass,
    method: row.method,
    matcherVersion: row.matcherVersion,
    proposedAt: row.proposedAt,
  };
}

async function loadLinkRaw(linkId: string): Promise<typeof personLinks.$inferSelect | null> {
  const db = getDb();
  const rows = await db.select().from(personLinks).where(eq(personLinks.id, linkId)).limit(1);
  return rows[0] ?? null;
}

async function loadLinkForPair(prnA: string, prnB: string): Promise<typeof personLinks.$inferSelect | null> {
  const db = getDb();
  const rows = await db
    .select()
    .from(personLinks)
    .where(and(eq(personLinks.prnA, prnA), eq(personLinks.prnB, prnB)))
    .limit(1);
  return rows[0] ?? null;
}

async function loadLatestDecision(linkId: string): Promise<typeof personLinkDecisions.$inferSelect | null> {
  const db = getDb();
  const rows = await db
    .select()
    .from(personLinkDecisions)
    .where(eq(personLinkDecisions.linkId, linkId))
    .orderBy(desc(personLinkDecisions.decidedAt))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Inserta UNA fila de `person_link_decisions` (append-only, atribuida) —
 * mismo shape de `evidenceSnapshot` en los tres call sites que escriben una
 * decisión (`decideLink`, `unmergeLink`, `rescindLiveLink`): congela
 * score/evidence/evidenceClass/matcherVersion del link TAL COMO ESTABA en el
 * momento de la decisión.
 */
async function insertLinkDecision(
  linkId: string,
  decision: string,
  note: string,
  row: typeof personLinks.$inferSelect,
  actorId: string,
): Promise<void> {
  await getDb()
    .insert(personLinkDecisions)
    .values({
      id: randomUUID(),
      linkId,
      decision,
      note,
      evidenceSnapshot: {
        score: row.score,
        evidence: row.evidence,
        evidenceClass: row.evidenceClass,
        matcherVersion: row.matcherVersion,
      },
      decidedBy: actorId,
      decidedAt: Date.now(),
      ...incidentOwnership(
        row.organizationId && row.incidentId
          ? tenantScopeFromIds({
              organizationId: row.organizationId,
              incidentId: row.incidentId,
            })
          : colombiaTenantScope(),
      ),
    });
}

// ----------------------------------------------------- error de escalación ---

/**
 * Escalación de fusión ANCLADA (R18): confirmar este vínculo uniría dos
 * clusters que ya tienen identidad propia, y el actor no tiene
 * `person:merge`. Subclase de `HttpError` (403) — nunca se toca
 * `lib/errors.ts` (fuera del alcance de U9): el "código distinto" que pide
 * el contrato vive en `.code`, legible por quien atrapa el error
 * directamente (tests de servicio); el mensaje HTTP (único campo que el
 * `errorHandler` central serializa hoy) es el texto distintivo para el
 * cliente.
 */
export class AnchoredMergeEscalationError extends HttpError {
  readonly code = "anchored_merge_requires_person_merge";
  constructor(message: string) {
    super(403, message);
    this.name = "AnchoredMergeEscalationError";
  }
}

// --------------------------------------------------------- claim/revert ---

type LinkStatus = "proposed" | "confirmed" | "rejected" | "unsure";

/**
 * CLAIM condicional (paso 2 del protocolo): intenta mover `linkId` de
 * 'proposed' O 'unsure' a `targetStatus`, en DOS UPDATEs condicionales
 * secuenciales (una por prior posible) en vez de un único WHERE con OR —
 * así conocemos EXACTAMENTE cuál era el estado previo (necesario para poder
 * revertir al valor exacto, no solo "a proposed") sin depender de trucos de
 * CTE sobre la misma fila que se está actualizando. Cada UPDATE es atómica
 * por sí sola; como el status solo puede tener UN valor a la vez, como
 * mucho una de las dos puede tener éxito.
 */
async function claimLink(
  linkId: string,
  targetStatus: LinkStatus,
): Promise<{ row: typeof personLinks.$inferSelect; priorStatus: "proposed" | "unsure" } | null> {
  const db = getDb();
  for (const prior of ["proposed", "unsure"] as const) {
    const rows = await db
      .update(personLinks)
      .set({ status: targetStatus })
      .where(and(eq(personLinks.id, linkId), eq(personLinks.status, prior)))
      .returning();
    if (rows[0]) return { row: rows[0], priorStatus: prior };
  }
  return null;
}

/** Revierte el claim al valor EXACTO previo — condicionado a que siga en
 *  `targetStatus` (defensivo: en la práctica esto corre inline, en el mismo
 *  request, milisegundos después del claim). NO toca person_link_decisions —
 *  el contrato exige "NO decision row" en el camino de escalación. */
async function revertClaim(linkId: string, targetStatus: LinkStatus, priorStatus: LinkStatus): Promise<void> {
  const db = getDb();
  await db
    .update(personLinks)
    .set({ status: priorStatus })
    .where(and(eq(personLinks.id, linkId), eq(personLinks.status, targetStatus)));
}

// ------------------------------------------------------- decide (R12/R18) ---

const DECISION_TO_STATUS: Record<"confirmar" | "rechazar" | "inseguro", LinkStatus> = {
  confirmar: "confirmed",
  rechazar: "rejected",
  inseguro: "unsure",
};

export interface DecideLinkInput {
  linkId: string;
  decision: "confirmar" | "rechazar" | "inseguro";
  /** "" si no se envió — el router exige no-vacío para 'inseguro' vía zod. */
  note: string;
  actorId: string;
  actorHasMergeCapability: boolean;
}

export interface DecideLinkResult {
  link: PersonLinkDTO;
  /** true = 200 de replay idempotente (mismo revisor, misma decisión); no se
   *  insertó una fila de decisión nueva. */
  idempotentReplay: boolean;
  /** true = esta confirmación SÍ era una fusión anclada (y el actor SÍ tenía
   *  person:merge — si no, ya se lanzó la escalación antes de llegar aquí).
   *  El router usa esto para además auditar `cluster.merge`. */
  anchoredMergeExecuted: boolean;
}

/**
 * Protocolo completo de decisión (R12/R18/R20), en el orden exacto del plan:
 *  1. (zod ya corrió en el router)
 *  2. CLAIM condicional.
 *  3. 0 filas → replay idempotente (mismo revisor+decisión) o 409.
 *  4. Re-chequeo de anclaje DESPUÉS del claim (TOCTOU) — solo aplica a
 *     'confirmar'. Ancorado + sin person:merge → revierte el claim (sin fila
 *     de decisión) y lanza la escalación.
 *  5. Inserta la fila de decisión (append-only, atribuida).
 *  6. Si fue 'confirmar': recompute de ambos PRNs.
 *  7. (el router hace writeAudit — fuera de este service a propósito, igual
 *     que el resto del repo).
 */
export async function decideLink(input: DecideLinkInput): Promise<DecideLinkResult> {
  const targetStatus = DECISION_TO_STATUS[input.decision];

  const claim = await claimLink(input.linkId, targetStatus);
  if (!claim) {
    const current = await loadLinkRaw(input.linkId);
    if (!current) throw notFound("Vínculo no encontrado.");
    const latest = await loadLatestDecision(input.linkId);
    if (latest && latest.decidedBy === input.actorId && latest.decision === targetStatus) {
      return { link: toLinkDTO(current), idempotentReplay: true, anchoredMergeExecuted: false };
    }
    throw conflict(
      "Este vínculo ya fue decidido por otro revisor o cambió de estado; recárgalo e inténtalo de nuevo.",
    );
  }

  const { row, priorStatus } = claim;

  let anchoredMerge = false;
  if (input.decision === "confirmar") {
    anchoredMerge = await isAnchoredMerge(row.prnA, row.prnB, row.id);
    if (anchoredMerge && !input.actorHasMergeCapability) {
      await revertClaim(input.linkId, targetStatus, priorStatus);
      throw new AnchoredMergeEscalationError(
        "Esta confirmación uniría dos clusters que ya tienen identidad propia (fusión anclada). Se requiere el permiso person:merge para completarla.",
      );
    }
  }

  await insertLinkDecision(input.linkId, targetStatus, input.note ?? "", row, input.actorId);

  if (input.decision === "confirmar") {
    await recomputeClusterFor(row.prnA);
    await recomputeClusterFor(row.prnB);
  }
  // 'rechazar': nada más — la semántica de tombstone vive en el matcher
  // (propose.ts KTD4/KTD5: reabrir exige clase estrictamente más fuerte).
  // 'inseguro': el status ya quedó fijado por el claim.

  const finalRow = await loadLinkRaw(input.linkId);
  return { link: toLinkDTO(finalRow!), idempotentReplay: false, anchoredMergeExecuted: anchoredMerge };
}

// --------------------------------------------------- propuesta manual (R16) ---

/** Clase de evidencia de una propuesta manual (R16): NO viene del matcher —
 *  un revisor humano decidió vincular dos registros a mano, sin evidencia de
 *  campo comparable (documento/nombre+edad). */
export const MANUAL_EVIDENCE_CLASS = "manual" as const;

/**
 * Ranking LOCAL a este módulo para comparar 'manual' contra las clases del
 * matcher (`EvidenceClass` de propose.ts) — NO se extiende el mapa cerrado
 * de propose.ts (typed a sus 2 clases, y ese archivo está fuera del alcance
 * de U9: tocarlo para añadir 'manual' sería modificar el matcher). 'manual'
 * se ubica DEBAJO de 'name_age_exact': una propuesta manual nunca debería
 * poder reabrir, por sí sola, un rechazo que ya vio evidencia de campo real
 * — si esa evidencia más fuerte existiera de verdad, el matcher la habría
 * encontrado.
 *
 * Uso actual: NINGUNO de los caminos de escritura de este archivo compara
 * rangos hoy (`manualProposeLink` solo inserta si el par no existe, o
 * devuelve la fila existente si sigue abierta — proposed/unsure —, o 409 si
 * ya fue decidida; nunca intenta "subir de clase" una fila ya rechazada).
 * Este mapa documenta explícitamente el ranking pretendido para cuando una
 * fase futura sí necesite esa comparación (p.ej. permitir que una propuesta
 * manual reabra un rechazo cuando 'manual' > la clase que rechazó).
 */
export const LOCAL_EVIDENCE_CLASS_RANK: Record<"manual" | EvidenceClass, number> = {
  manual: 0,
  name_age_exact: evidenceClassRank("name_age_exact"),
  document_hash_exact: evidenceClassRank("document_hash_exact"),
};

export interface ManualProposeInput {
  prnA: string;
  prnB: string;
  actorId: string;
}

export interface ManualProposeResult {
  link: PersonLinkDTO;
  /** true = se insertó una fila nueva (201); false = ya existía y estaba
   *  abierta (proposed/unsure) — se devuelve tal cual, idempotente (200). */
  created: boolean;
}

/**
 * Propone un vínculo A MANO (R16): cualquier orden de entrada, el servicio
 * ordena el par (`orderPair`, compartido con el matcher). 400 si algún PRN
 * no normaliza/no existe o si ambos resuelven al mismo PRN; si el par YA
 * tiene una fila 'proposed'/'unsure' se devuelve tal cual (200, idempotente);
 * si ya está 'confirmed'/'rejected', 409 (ese par ya fue decidido — una
 * propuesta manual no reabre una decisión, ver LOCAL_EVIDENCE_CLASS_RANK).
 */
export async function manualProposeLink(input: ManualProposeInput): Promise<ManualProposeResult> {
  const normA = normalizePrn(input.prnA);
  const normB = normalizePrn(input.prnB);
  if (!normA || !normB) throw badRequest("PRN inválido.");

  const [refA, refB] = await Promise.all([resolvePrn(normA), resolvePrn(normB)]);
  if (!refA || !refB) throw badRequest("Uno o ambos PRN no existen.");

  const [prnA, prnB] = orderPair(normA, normB);
  if (prnA === prnB) throw badRequest("No se puede vincular un registro consigo mismo.");

  const db = getDb();
  const existing = await loadLinkForPair(prnA, prnB);
  if (existing) {
    if (existing.status === "proposed" || existing.status === "unsure") {
      return { link: toLinkDTO(existing), created: false };
    }
    throw conflict(`El par ya tiene un vínculo en estado "${existing.status}".`);
  }

  const now = Date.now();
  const inserted = await db
    .insert(personLinks)
    .values({
      id: randomUUID(),
      prnA,
      prnB,
      status: "proposed",
      score: null,
      evidence: {},
      evidenceClass: MANUAL_EVIDENCE_CLASS,
      method: "manual",
      matcherVersion: null,
      proposedAt: now,
      ...incidentOwnership(colombiaTenantScope()),
    })
    .onConflictDoNothing({ target: [personLinks.prnA, personLinks.prnB] })
    .returning();

  if (inserted[0]) return { link: toLinkDTO(inserted[0]), created: true };

  // Carrera perdida contra otra propuesta (manual o del matcher) para el
  // MISMO par: re-lee y aplica la misma regla idempotente-o-409.
  const raced = await loadLinkForPair(prnA, prnB);
  if (raced && (raced.status === "proposed" || raced.status === "unsure")) {
    return { link: toLinkDTO(raced), created: false };
  }
  throw conflict(`El par ya tiene un vínculo en estado "${raced?.status ?? "desconocido"}".`);
}

// ------------------------------------------------------------ unmerge (R15) ---

export interface UnmergeInput {
  linkId: string;
  actorId: string;
  note?: string;
}

export interface UnmergeResult {
  link: PersonLinkDTO;
  prnA: string;
  prnB: string;
}

/**
 * Deshace una fusión (R15): SOLO sobre un vínculo 'confirmed'. Append-only:
 * NO se borra ni se edita la decisión de confirmación original — se agrega
 * una nueva fila 'rescinded'; el link pasa a 'rejected' (tombstone: el
 * matcher no lo re-propondrá con la MISMA clase de evidencia — KTD4/KTD5 de
 * propose.ts, sin cambios aquí). Recompute de ambos PRNs (el/los cluster(s)
 * pueden encogerse — ver sub-paso 5 de recomputeClusterFor para cómo evita
 * dejar miembros varados) + un sweep del matcher para ambos (por si alguna
 * OTRA evidencia, distinta a la que unió este par, amerita una propuesta
 * fresca contra otros registros).
 */
export async function unmergeLink(input: UnmergeInput): Promise<UnmergeResult> {
  const db = getDb();
  const current = await loadLinkRaw(input.linkId);
  if (!current) throw notFound("Vínculo no encontrado.");

  if (current.status !== "confirmed") {
    // Replay idempotente: si YA fue deshecho (rejected + hay una decisión
    // 'rescinded'), un segundo unmerge no es un error — el estado deseado ya
    // existe.
    if (current.status === "rejected") {
      const latest = await loadLatestDecision(input.linkId);
      if (latest?.decision === "rescinded") {
        return { link: toLinkDTO(current), prnA: current.prnA, prnB: current.prnB };
      }
    }
    throw conflict(`Solo se puede deshacer un vínculo confirmado (estado actual: "${current.status}").`);
  }

  const claimed = await db
    .update(personLinks)
    .set({ status: "rejected" })
    .where(and(eq(personLinks.id, input.linkId), eq(personLinks.status, "confirmed")))
    .returning();
  const row = claimed[0];
  if (!row) {
    // Carrera perdida contra otro unmerge/decisión concurrente sobre el
    // mismo link — re-verifica el mismo camino idempotente de arriba.
    const reread = await loadLinkRaw(input.linkId);
    const latest = await loadLatestDecision(input.linkId);
    if (reread?.status === "rejected" && latest?.decision === "rescinded") {
      return { link: toLinkDTO(reread), prnA: reread.prnA, prnB: reread.prnB };
    }
    throw conflict("El vínculo cambió de estado antes de poder deshacerlo; recárgalo e inténtalo de nuevo.");
  }

  await insertLinkDecision(input.linkId, "rescinded", input.note ?? "", row, input.actorId);

  await recomputeClusterFor(row.prnA);
  await recomputeClusterFor(row.prnB);
  await enqueueMatcherSweep([row.prnA, row.prnB]);

  const finalRow = await loadLinkRaw(input.linkId);
  return { link: toLinkDTO(finalRow!), prnA: row.prnA, prnB: row.prnB };
}

// --------------------------------------------------- rescindir (U9/U10) ---

/** Estados "vivos" de un link — cualquiera puede rescindirse: un unmerge (R15,
 *  siempre 'confirmed') o el tombstone de un registro fuente borrado (U10,
 *  que puede tocar un link que nunca llegó a 'confirmed'). */
const LIVE_LINK_STATUSES = ["proposed", "unsure", "confirmed"] as const;

export interface RescindLinkResult {
  row: typeof personLinks.$inferSelect;
}

/**
 * Rescinde UN link vivo (proposed/unsure/confirmed) a 'rejected' + una fila de
 * decisión 'rescinded' atribuida — CLAIM condicional (mismo idioma que
 * `claimLink` de arriba, generalizado a los 3 status vivos en vez de solo
 * proposed/unsure) + el MISMO insert append-only que `unmergeLink` escribe
 * para el caso 'confirmed'.
 *
 * Export NUEVO para U10 (`services/person-records.ts:tombstonePersonRecord`,
 * import DINÁMICO desde allá — ver su docstring sobre el ciclo que evita):
 * cuando se borra un registro fuente con vínculos abiertos que nunca llegaron
 * a 'confirmed', esta es la MISMA disciplina de escritura de
 * `person_link_decisions` que `unmergeLink` ya usa, sin duplicarla. NO
 * modifica `unmergeLink` (que sigue exigiendo 'confirmed' antes de intentar
 * nada, con su propio manejo de replay idempotente) — comportamiento de esa
 * función intacto.
 *
 * `null` si el link ya no está en ningún status vivo (perdió la carrera contra
 * otra decisión/rescind concurrente, o ya fue decidido) — no es un error; el
 * llamador decide si ese no-op es aceptable (`tombstonePersonRecord` sí lo
 * es: nada que rescindir es un resultado válido).
 */
export async function rescindLiveLink(
  linkId: string,
  actorId: string,
  note = "",
): Promise<RescindLinkResult | null> {
  const db = getDb();
  let claimed: typeof personLinks.$inferSelect | undefined;
  for (const prior of LIVE_LINK_STATUSES) {
    const rows = await db
      .update(personLinks)
      .set({ status: "rejected" })
      .where(and(eq(personLinks.id, linkId), eq(personLinks.status, prior)))
      .returning();
    if (rows[0]) {
      claimed = rows[0];
      break;
    }
  }
  if (!claimed) return null;

  await insertLinkDecision(linkId, "rescinded", note, claimed, actorId);

  return { row: claimed };
}

// --------------------------------------------------------- cola de revisión ---

export interface QueueCursor {
  proposedAt: number;
  id: string;
}

export interface QueueFilter {
  status?: LinkStatus;
  before?: QueueCursor | null;
  limit?: number;
}

export interface QueueItemDTO {
  link: PersonLinkDTO;
  a: RecordDisplay | null;
  b: RecordDisplay | null;
  /** Banner de "esto ya se rechazó antes" (R14): la última decisión
   *  rechazada/rescindida de ESTE link, si la hay — solo tiene sentido para
   *  filas 'proposed' que son en realidad una RE-propuesta tras evidencia
   *  más fuerte. `null` si nunca hubo un rechazo/rescind previo. */
  priorRejection: DecisionHistoryEntryDTO | null;
}

async function loadPriorRejections(linkIds: string[]): Promise<Map<string, DecisionHistoryEntryDTO>> {
  const out = new Map<string, DecisionHistoryEntryDTO>();
  if (linkIds.length === 0) return out;
  const db = getDb();
  const rows = await db
    .select()
    .from(personLinkDecisions)
    .where(and(inArray(personLinkDecisions.linkId, linkIds), inArray(personLinkDecisions.decision, ["rejected", "rescinded"])))
    .orderBy(desc(personLinkDecisions.decidedAt));
  for (const row of rows) {
    if (out.has(row.linkId)) continue; // ya se quedó con la más reciente
    out.set(row.linkId, {
      id: row.id,
      linkId: row.linkId,
      prnA: "",
      prnB: "",
      decision: row.decision,
      note: row.note,
      evidenceSnapshot: row.evidenceSnapshot,
      decidedBy: row.decidedBy,
      decidedAt: row.decidedAt,
    });
  }
  return out;
}

/**
 * Cola de revisión (R12): banda fuerte primero (`document_hash_exact`),
 * luego score desc; cursor keyset `(proposed_at, id)` (mismo idioma que
 * `services/audit.ts`/`audit.router.ts`).
 *
 * NOTA (deviation documentada): el orden de negocio (clase fuerte primero,
 * luego score) NO coincide con las columnas del cursor keyset
 * (proposed_at, id) — un keyset "puro" exige que ambos coincidan para
 * garantizar que ninguna página se salte o repita una fila. Se implementa
 * tal como lo pide el plan (cursor simple sobre proposed_at/id, "per
 * audit.router.ts") porque a los volúmenes de fase 1 el WHERE de corte
 * (`(proposed_at, id) < cursor`) sigue acotando correctamente el AVANCE de
 * la paginación (nunca repite hacia atrás en el tiempo), aunque en teoría
 * una fila con proposed_at "antiguo" pero clase fuerte podría reordenarse
 * cerca del límite de una página. Aceptable para una cola de revisión
 * humana en este volumen; no es la garantía dura de un keyset canónico.
 */
export async function listQueue(filter: QueueFilter): Promise<QueueItemDTO[]> {
  const db = getDb();
  const status = filter.status ?? "proposed";
  const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200);

  const conditions = [eq(personLinks.status, status)];
  if (filter.before) {
    conditions.push(
      sql`(${personLinks.proposedAt}, ${personLinks.id}) < (${filter.before.proposedAt}, ${filter.before.id})`,
    );
  }

  const rows = await db
    .select()
    .from(personLinks)
    .where(and(...conditions))
    .orderBy(
      sql`(CASE WHEN ${personLinks.evidenceClass} = 'document_hash_exact' THEN 0 ELSE 1 END) ASC`,
      sql`${personLinks.score} DESC NULLS LAST`,
      desc(personLinks.proposedAt),
      desc(personLinks.id),
    )
    .limit(limit);

  if (rows.length === 0) return [];

  const allPrns = Array.from(new Set(rows.flatMap((r) => [r.prnA, r.prnB])));
  const [displays, priorRejections] = await Promise.all([
    loadDisplayFields(allPrns),
    loadPriorRejections(rows.map((r) => r.id)),
  ]);

  return rows.map((r) => ({
    link: toLinkDTO(r),
    a: displays.get(r.prnA) ?? null,
    b: displays.get(r.prnB) ?? null,
    priorRejection: priorRejections.get(r.id) ?? null,
  }));
}

// ----------------------------------------------------- búsqueda de registros ---

/** Detección (cacheada) de `f_unaccent` — mismo idioma que
 *  matcher/candidates.ts y services/missing.ts, duplicado a propósito (es el
 *  patrón ya establecido en este repo: cada módulo de búsqueda lo detecta
 *  por su cuenta en vez de compartir un singleton entre archivos). */
let _unaccentReady: Promise<boolean> | null = null;
function unaccentReady(): Promise<boolean> {
  if (!_unaccentReady) {
    _unaccentReady = (async () => {
      try {
        const db = getDb();
        const res = await db.execute(sql`SELECT to_regprocedure('public.f_unaccent(text)') AS oid`);
        const rows = execRows<{ oid: string | null }>(res);
        return Boolean(rows[0]?.oid);
      } catch {
        return false;
      }
    })();
  }
  return _unaccentReady;
}

/** Normalización JS de nombre (minúsculas + sin acentos) — se reutiliza la
 *  de matcher/candidates.ts (vía matcher/index.ts) en vez de duplicarla. */
async function importNormalizeName(): Promise<(raw: string) => string> {
  const { normalizeName } = await import("@/services/matcher");
  return normalizeName;
}

const SEARCH_TABLES = ["missing_persons", "hospital_patients", "unidentified_persons"] as const;
type SearchTable = (typeof SEARCH_TABLES)[number];
const SEARCH_TABLE_TO_RECORD_TYPE: Record<SearchTable, string> = {
  missing_persons: "missing_report",
  hospital_patients: "hospital_patient",
  unidentified_persons: "unidentified_person",
};

/** Bounded scan (fallback sin f_unaccent) — mismo criterio de "bounded scans
 *  are acceptable at current volumes" ya documentado en candidates.ts. */
const SEARCH_FALLBACK_SCAN_LIMIT = 1000;

async function searchNameInTable(
  table: SearchTable,
  rawTerm: string,
  useAccent: boolean,
  limit: number,
): Promise<string[]> {
  const db = getDb();
  const t = sql.raw(`"${table}"`); // catálogo cerrado (SEARCH_TABLES), nunca de una request.
  const nameExpr = table === "unidentified_persons" ? sql`(t.name || ' ' || t.surname)` : sql`t.name`;

  if (useAccent) {
    const rows = execRows<{ id: string }>(
      await db.execute(sql`
        SELECT t.id FROM ${t} t WHERE lower(f_unaccent(${nameExpr})) ILIKE ${`%${rawTerm.toLowerCase()}%`} LIMIT ${limit}
      `),
    );
    return rows.map((r) => r.id);
  }

  const normalizeName = await importNormalizeName();
  const normTerm = normalizeName(rawTerm);
  // Recientes-primero: sin orden, "qué 1000 filas entran al scan" es
  // arbitrario y una fila recién creada puede quedar fuera cuando la tabla
  // supera la cota. hospital_patients no tiene created_at — su columna de
  // recencia es admitted_at.
  const recencyCol = sql.raw(table === "hospital_patients" ? "t.admitted_at" : "t.created_at");
  const rows = execRows<{ id: string; hay: string }>(
    await db.execute(
      sql`SELECT t.id, ${nameExpr} AS hay FROM ${t} t ORDER BY ${recencyCol} DESC LIMIT ${SEARCH_FALLBACK_SCAN_LIMIT}`,
    ),
  );
  return rows
    .filter((r) => normalizeName(r.hay).includes(normTerm))
    .slice(0, limit)
    .map((r) => r.id);
}

async function prnsForRecords(hits: { recordType: string; recordId: string }[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (hits.length === 0) return out;
  const db = getDb();
  const { personRecords } = schema;
  const conditions = hits.map((h) => and(eq(personRecords.recordType, h.recordType), eq(personRecords.recordId, h.recordId)));
  const rows = await db
    .select({ recordType: personRecords.recordType, recordId: personRecords.recordId, prn: personRecords.prn })
    .from(personRecords)
    .where(or(...conditions));
  for (const r of rows) out.set(`${r.recordType}:${r.recordId}`, r.prn);
  return out;
}

export interface RecordSearchResult {
  /** Si `q` normaliza a un PRN válido Y existente, su ficha de presentación. */
  exactPrnMatch: RecordDisplay | null;
  results: RecordDisplay[];
}

/**
 * Búsqueda de registros (R19): por nombre (idioma acento-insensible de
 * missing.ts, sobre las 3 tablas fuente) + salto exacto por PRN
 * (`resolvePrn`, ya normaliza cualquier variante razonable). Registros sin
 * PRN estampado todavía (best-effort: `ensurePrn` es fire-and-forget en el
 * camino de creación) simplemente no aparecen hasta que el cron de
 * reconciliación los estampe — no se escribe nada desde un GET.
 */
export async function searchRecords(query: string, limit = 25): Promise<RecordSearchResult> {
  const trimmed = query.trim();
  if (!trimmed) return { exactPrnMatch: null, results: [] };
  const boundedLimit = Math.min(Math.max(Math.trunc(limit) || 25, 1), 100);

  const normalizedPrn = normalizePrn(trimmed);
  let exactPrnMatch: RecordDisplay | null = null;
  if (normalizedPrn) {
    const ref = await resolvePrn(normalizedPrn);
    if (ref) {
      const displays = await loadDisplayFields([normalizedPrn]);
      exactPrnMatch = displays.get(normalizedPrn) ?? null;
    }
  }

  if (trimmed.length < 2) return { exactPrnMatch, results: [] };

  const useAccent = await unaccentReady();
  const idsByTable = await Promise.all(
    SEARCH_TABLES.map((table) => searchNameInTable(table, trimmed, useAccent, boundedLimit)),
  );

  const hits = SEARCH_TABLES.flatMap((table, i) =>
    idsByTable[i]!.map((id) => ({ recordType: SEARCH_TABLE_TO_RECORD_TYPE[table], recordId: id })),
  );
  const prnMap = await prnsForRecords(hits);
  const prns = [...new Set(prnMap.values())].filter((p) => p !== normalizedPrn);
  const displays = await loadDisplayFields(prns);

  const results = prns
    .map((p) => displays.get(p))
    .filter((d): d is RecordDisplay => Boolean(d))
    .slice(0, boundedLimit);

  return { exactPrnMatch, results };
}

// --------------------------------------------------------- scanNotesForPii ---

/** ≥6 dígitos consecutivos — huella de un documento/cédula/teléfono crudo
 *  colado en texto libre. */
const DIGIT_RUN_PATTERN = "\\d{6,}";

export interface PiiScanResult {
  /** Solo IDS — nunca el texto de la nota/metadata (esa es la garantía: esta
   *  función jamás lee el contenido hacia JS, el filtro corre en SQL). */
  decisionOffenderIds: string[];
  auditOffenderIds: number[];
}

/**
 * Barrido de PII en texto libre (R11 extendido a U9): `person_link_decisions
 * .note` completo + `audit_log.metadata::text` SOLO para acciones
 * `personlink.*`. El filtro de dígitos corre EN SQL (`~`) — el resultado
 * nunca trae la nota/metadata cruda a memoria de la app, solo los ids de las
 * filas ofensoras (para que un operador las revise directamente en la DB).
 */
export async function scanNotesForPii(): Promise<PiiScanResult> {
  const db = getDb();
  const decisionRows = execRows<{ id: string }>(
    await db.execute(sql`
      SELECT id FROM person_link_decisions WHERE note ~ ${DIGIT_RUN_PATTERN}
    `),
  );
  const auditRows = execRows<{ id: string | number }>(
    await db.execute(sql`
      SELECT id FROM audit_log
      WHERE action LIKE 'personlink.%' AND metadata IS NOT NULL AND metadata::text ~ ${DIGIT_RUN_PATTERN}
    `),
  );
  return {
    decisionOffenderIds: decisionRows.map((r) => r.id),
    // audit_log.id es bigserial: el driver puede devolverlo como string en
    // una query cruda (sin el mapeo de columna de drizzle) — se normaliza
    // aquí, nunca se expone el string crudo.
    auditOffenderIds: auditRows.map((r) => Number(r.id)),
  };
}

// -------------------------------------------- comprobaciones de invariante ---
// KTD8 — enganchadas desde person-records.ts:runClusterInvariantChecks.

/**
 * Presupuesto de tiempo por defecto de un reparo (a)/(c) — MISMO número que
 * `CLUSTER_INVARIANT_CONNECTIVITY_BUDGET_MS` en person-records.ts (no se
 * importa esa constante: no está exportada, y person-records.ts ya importa
 * ESTE archivo dinámicamente — importar en la otra dirección sería el mismo
 * ciclo que `runClusterInvariantChecks` documenta evitar). Se repite el
 * valor con esta nota como único punto de sincronización.
 */
const DEFAULT_REPAIR_TIME_BUDGET_MS = 5_000;

/**
 * Cota del SELECT inicial de cada reparo (a)/(c) — mismo criterio de "bounded
 * scans are acceptable at current volumes" ya documentado más abajo para
 * `searchNameInTable` (`SEARCH_FALLBACK_SCAN_LIMIT`). Sin esto, el SELECT
 * completo de `person_links` crecería sin cota junto con la tabla, y estos
 * dos reparos corren en CADA tick del cron de reconciliación (cada 5
 * minutos) — no en la cadencia lenta de (b).
 *
 * Sin cursor persistente entre corridas: un cursor a nivel de módulo NO
 * sobrevive a un isolate reciclado en Workers (no hay garantía de que el
 * siguiente tick del cron lo vea), y añadir una columna de watermark
 * persistida está fuera del alcance de este reparo. Se prefiere en su lugar
 * `ORDER BY id ASC LIMIT N`: siempre acota el trabajo por tick, a costa de
 * re-chequear los links con id "menor" en cada corrida mientras que los que
 * caen fuera del límite tardan más en recibir su primera pasada. Tradeoff
 * aceptado a propósito — preferible a un SELECT sin límite.
 */
const REPAIR_SCAN_LIMIT = 1000;

export interface RepairEndpointsResult {
  checked: number;
  repaired: number;
  /** true = el SELECT inicial trajo REPAIR_SCAN_LIMIT filas y/o el presupuesto
   *  de tiempo cortó la corrida antes de procesarlas todas — queda trabajo
   *  para el próximo tick del cron. */
  reachedBudget: boolean;
}

/** (a) Todo link CONFIRMADO: ambos extremos deben compartir un cluster vivo.
 *  Reparo: recompute de ambos extremos (recomputeClusterFor es idempotente —
 *  si ya coinciden, no hace nada). Acotado (mismo idioma que
 *  `repairClusterConnectivity`): SELECT con LIMIT + presupuesto de tiempo
 *  chequeado entre iteraciones — este reparo corre en CADA tick del cron de
 *  reconciliación (5 min), así que su costo no puede crecer sin cota con
 *  `person_links`. */
export async function repairConfirmedLinkEndpoints(
  opts: { timeBudgetMs?: number } = {},
): Promise<RepairEndpointsResult> {
  const timeBudgetMs = opts.timeBudgetMs ?? DEFAULT_REPAIR_TIME_BUDGET_MS;
  const db = getDb();
  const startedAt = Date.now();
  const rows = await db
    .select({ id: personLinks.id, prnA: personLinks.prnA, prnB: personLinks.prnB })
    .from(personLinks)
    .where(eq(personLinks.status, "confirmed"))
    .orderBy(personLinks.id)
    .limit(REPAIR_SCAN_LIMIT);

  let checked = 0;
  let repaired = 0;
  let reachedBudget = rows.length >= REPAIR_SCAN_LIMIT;
  for (const row of rows) {
    if (Date.now() - startedAt > timeBudgetMs) {
      reachedBudget = true;
      break;
    }
    checked++;
    const [clusterA, clusterB] = await Promise.all([liveClusterOf(row.prnA), liveClusterOf(row.prnB)]);
    if (!clusterA || !clusterB || clusterA !== clusterB) {
      await recomputeClusterFor(row.prnA);
      await recomputeClusterFor(row.prnB);
      repaired++;
    }
  }
  return { checked, repaired, reachedBudget };
}

export interface RepairConnectivityResult {
  checked: number;
  repaired: number;
  reachedBudget: boolean;
}

/** (b) Conectividad interna de cada cluster (los miembros vivos de un
 *  cluster deben ser TODOS mutuamente alcanzables por links confirmados) —
 *  capado por presupuesto de tiempo, cadencia lenta (person-records.ts la
 *  llama 1 de cada N corridas). Reparo: recompute de cada miembro "extraño"
 *  (no alcanzable desde el resto del cluster). */
export async function repairClusterConnectivity(
  opts: { timeBudgetMs: number },
): Promise<RepairConnectivityResult> {
  const db = getDb();
  const startedAt = Date.now();
  const clusterRows = await db.select({ id: personClusters.id }).from(personClusters);

  let checked = 0;
  let repaired = 0;
  let reachedBudget = false;

  for (const cluster of clusterRows) {
    if (Date.now() - startedAt > opts.timeBudgetMs) {
      reachedBudget = true;
      break;
    }
    checked++;
    const liveMembers = await liveMembersOf(cluster.id);
    if (liveMembers.length <= 1) continue;

    const component = await confirmedComponent(liveMembers[0]!);
    const strays = liveMembers.filter((m) => !component.has(m));
    for (const stray of strays) {
      await recomputeClusterFor(stray);
      repaired++;
    }
  }
  return { checked, repaired, reachedBudget };
}

export interface RepairUndecidedResult {
  checked: number;
  reverted: number;
  /** true = el SELECT inicial trajo REPAIR_SCAN_LIMIT filas y/o el presupuesto
   *  de tiempo cortó la corrida antes de procesarlas todas — queda trabajo
   *  para el próximo tick del cron (ver REPAIR_SCAN_LIMIT). */
  reachedBudget: boolean;
}

/** (c) Todo link cuyo status implica una decisión humana (confirmed/rejected/
 *  unsure) debe tener AL MENOS una fila en person_link_decisions. Si no —
 *  atribución que solo existió en un request que se cayó a medias entre el
 *  claim y el insert de la decisión — se REVIERTE a 'proposed' (nunca se
 *  fabrica una decisión que nadie tomó). Acotado igual que
 *  `repairConfirmedLinkEndpoints` (mismo motivo: corre en cada tick del cron
 *  de reconciliación, no en la cadencia lenta de (b)). */
export async function repairUndecidedStatuses(
  opts: { timeBudgetMs?: number } = {},
): Promise<RepairUndecidedResult> {
  const timeBudgetMs = opts.timeBudgetMs ?? DEFAULT_REPAIR_TIME_BUDGET_MS;
  const db = getDb();
  const startedAt = Date.now();
  const rows = await db
    .select({ id: personLinks.id, status: personLinks.status })
    .from(personLinks)
    .where(inArray(personLinks.status, ["confirmed", "rejected", "unsure"]))
    .orderBy(personLinks.id)
    .limit(REPAIR_SCAN_LIMIT);

  let checked = 0;
  let reverted = 0;
  let reachedBudget = rows.length >= REPAIR_SCAN_LIMIT;
  for (const row of rows) {
    if (Date.now() - startedAt > timeBudgetMs) {
      reachedBudget = true;
      break;
    }
    checked++;
    const has = await db
      .select({ id: personLinkDecisions.id })
      .from(personLinkDecisions)
      .where(eq(personLinkDecisions.linkId, row.id))
      .limit(1);
    if (!has[0]) {
      await db
        .update(personLinks)
        .set({ status: "proposed" })
        .where(and(eq(personLinks.id, row.id), eq(personLinks.status, row.status)));
      reverted++;
    }
  }
  return { checked, reverted, reachedBudget };
}
