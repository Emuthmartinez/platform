/**
 * Upsert de propuestas de link (U8) — el ÚNICO lugar que escribe
 * `person_links` en fase 1. Encapsula KTD4/KTD5 en UNA sentencia SQL
 * (`INSERT ... ON CONFLICT (prn_a, prn_b) DO UPDATE ... WHERE ...`) para que
 * la decisión de "¿se toca esta fila?" sea atómica frente a entregas
 * concurrentes/duplicadas del mensaje — nunca un SELECT-then-UPDATE con
 * ventana de carrera (mismo criterio anti-`db.transaction()` que
 * `services/person-records.ts`: el driver HTTP de Neon en Workers no soporta
 * transacciones interactivas).
 *
 * Reglas (KTD4/KTD5, restated en el plan U8):
 *   - El matcher SOLO puede insertar filas nuevas y actualizar filas cuyo
 *     `status` sea 'proposed' o 'unsure'. 'confirmed' es inmutable para el
 *     matcher SIEMPRE. 'rejected' es inmutable salvo la única excepción de
 *     abajo.
 *   - 'proposed': se refresca sin condición (todavía no hay decisión humana
 *     que proteger) — score/evidence/evidence_class/matcher_version/
 *     proposed_at se actualizan con el resultado más reciente del matcher.
 *   - 'unsure': un refresco de la MISMA clase actualiza score/evidence EN
 *     SITIO (el status se queda en 'unsure' — no hay motivo para devolver la
 *     fila a la cola si la evidencia no cambió de fuerza); una clase
 *     ESTRICTAMENTE más fuerte la pasa a 'proposed' (amerita que un revisor
 *     la vuelva a mirar). Una clase más débil que la ya guardada NO toca la
 *     fila (no hay regla que lo pida, y degradar evidencia ya vista sería
 *     confuso para el revisor).
 *   - 'rejected': el revisor ya decidió que NO son la misma persona con la
 *     evidencia que vio. Reabrir esa decisión exige una clase ESTRICTAMENTE
 *     más fuerte que la que rechazó — igual que 'unsure', nunca por una clase
 *     igual o más débil.
 *
 * Ranking de clases (fase 1, cerrado): `document_hash_exact` (2) >
 * `name_age_exact` (1). Extensible como enum ordenado en fase 2 (KTD4).
 */
import { sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { colombiaTenantScope } from "@/lib/colombia-tenant";
import { incidentOwnership } from "@/tenant/ownership";

const { personLinks } = schema;

export type EvidenceClass = "document_hash_exact" | "name_age_exact";

/** Ranking ascendente — SOLO este mapa define "más fuerte que". Cerrado a
 *  propósito (fase 1 es 100% determinista, sin score probabilístico real). */
const EVIDENCE_CLASS_RANK: Record<EvidenceClass, number> = {
  name_age_exact: 1,
  document_hash_exact: 2,
};

export function evidenceClassRank(evidenceClass: EvidenceClass): number {
  return EVIDENCE_CLASS_RANK[evidenceClass];
}

/** true si `a` es ESTRICTAMENTE más fuerte que `b` (nunca igual). */
export function isStrongerEvidenceClass(a: EvidenceClass, b: EvidenceClass): boolean {
  return evidenceClassRank(a) > evidenceClassRank(b);
}

export const MATCHER_METHOD = "deterministic";
export const MATCHER_VERSION = "det-1";

/**
 * Puntaje fijo por clase — fase 1 no es probabilística (KTD10): el "score" es
 * solo un desempate de ordenamiento para la cola de revisión de U9 ("banda
 * fuerte primero, luego score"), no una probabilidad calibrada. Una fase 2
 * probabilística reemplazaría esto por un puntaje real por par.
 */
const EVIDENCE_CLASS_SCORE: Record<EvidenceClass, number> = {
  document_hash_exact: 1,
  name_age_exact: 0.75,
};

/**
 * Tokens de evidencia — SOLO resultados de campo ("exact"), JAMÁS el valor
 * crudo (ni la cédula, ni el nombre, ni la edad). Exportada para que los
 * tests recorran su salida y aseguren el invariante (R11): ninguna clave de
 * `person_links.evidence` puede contener PII, solo el resultado booleano de
 * la comparación por campo.
 */
export function buildEvidence(evidenceClass: EvidenceClass): Record<string, "exact"> {
  if (evidenceClass === "document_hash_exact") return { documento: "exact" };
  return { nombre: "exact", edad: "exact" };
}

/**
 * Ordena el par para que `prnA < prnB` (el CHECK `person_links_pair_ordered`
 * de la migración 0004 lo respalda — sin este helper, un insert con el par
 * invertido resucitaría un par rechazado como fila "nueva"). Único lugar de
 * esta lógica en fase 1: cuando U9 construya `person-links.ts` con sus otros
 * escritores (manual propose, rescind), este helper es el que se reutiliza.
 */
export function orderPair(prnX: string, prnY: string): [string, string] {
  return prnX < prnY ? [prnX, prnY] : [prnY, prnX];
}

export interface ProposeLinkInput {
  triggerPrn: string;
  counterpartPrn: string;
  evidenceClass: EvidenceClass;
}

/** Resultado de `proposeLink`: si la fila realmente se tocó (insertó o
 *  actualizó) en esta llamada — util para logging/tests, no es parte del
 *  contrato que otros módulos consuman. */
export interface ProposeLinkResult {
  prnA: string;
  prnB: string;
  applied: boolean;
}

/**
 * Propone (inserta) o refresca (actualiza) el link determinista para un par,
 * honrando KTD4/KTD5. Idempotente: la MISMA entrada, aplicada dos veces,
 * converge a la MISMA fila (la clave de conflicto es `UNIQUE (prn_a, prn_b)`
 * — `idx_person_links_pair`).
 */
export async function proposeLink(input: ProposeLinkInput): Promise<ProposeLinkResult> {
  const [prnA, prnB] = orderPair(input.triggerPrn, input.counterpartPrn);
  // Defensivo: candidates.ts ya excluye auto-pares, pero un candidato que por
  // error de datos resolviera al mismo PRN no debe intentar violar el CHECK
  // prn_a < prn_b (que rechazaría prn_a === prn_b) ni escribir nada.
  if (prnA === prnB) return { prnA, prnB, applied: false };

  const db = getDb();
  const evidence = buildEvidence(input.evidenceClass);
  const score = EVIDENCE_CLASS_SCORE[input.evidenceClass];
  const incomingRank = evidenceClassRank(input.evidenceClass);
  const now = Date.now();

  // Rango de la clase YA guardada en la fila en conflicto (si la hay) — se
  // evalúa del lado de Postgres porque no la conocemos hasta que el propio
  // INSERT choca contra el índice único; `incomingRank` en cambio ya es un
  // valor JS (la clase que ESTE candidato trae).
  const storedRank = sql`(CASE ${personLinks.evidenceClass}
    WHEN 'document_hash_exact' THEN 2
    WHEN 'name_age_exact' THEN 1
    ELSE 0
  END)`;

  const ownership = incidentOwnership(colombiaTenantScope());
  const rows = await db
    .insert(personLinks)
    .values({
      id: crypto.randomUUID(),
      prnA,
      prnB,
      status: "proposed",
      score,
      evidence,
      evidenceClass: input.evidenceClass,
      method: MATCHER_METHOD,
      matcherVersion: MATCHER_VERSION,
      proposedAt: now,
      ...ownership,
    })
    .onConflictDoUpdate({
      target: [personLinks.prnA, personLinks.prnB],
      set: {
        score,
        evidence,
        evidenceClass: input.evidenceClass,
        matcherVersion: MATCHER_VERSION,
        proposedAt: now,
        organizationId: sql`COALESCE(${personLinks.organizationId}, ${ownership.organizationId})`,
        incidentId: sql`COALESCE(${personLinks.incidentId}, ${ownership.incidentId})`,
        // Dentro de SET, una referencia sin `excluded.` a la columna de la
        // tabla es la fila EXISTENTE (pre-update) — exactamente lo que
        // necesitamos para decidir si "unsure" se queda igual o sube.
        status: sql`CASE
          WHEN ${personLinks.status} = 'unsure' AND ${personLinks.evidenceClass} = ${input.evidenceClass}
            THEN 'unsure'
          ELSE 'proposed'
        END`,
      },
      // El WHERE de un ON CONFLICT DO UPDATE es la máquina de estados
      // completa de KTD5: si ninguna rama coincide, Postgres NO toca la fila
      // (ni siquiera un no-op UPDATE) — así 'confirmed' queda byte-idéntico
      // sin necesitar una rama explícita que lo excluya.
      setWhere: sql`
        ${personLinks.status} = 'proposed'
        OR (
          ${personLinks.status} = 'unsure'
          AND (
            ${personLinks.evidenceClass} = ${input.evidenceClass}
            OR ${incomingRank} > ${storedRank}
          )
        )
        OR (
          ${personLinks.status} = 'rejected'
          AND ${incomingRank} > ${storedRank}
        )
      `,
    })
    .returning({ id: personLinks.id });

  return { prnA, prnB, applied: rows.length > 0 };
}
