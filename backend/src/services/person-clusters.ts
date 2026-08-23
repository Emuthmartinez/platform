/**
 * Motor de clusters (U9, R13/R18) — la "persona" es el componente conexo
 * sobre `person_links` CONFIRMADOS (solo). `recomputeClusterFor` converge la
 * membresía materializada (`person_cluster_members`) a ese componente; los
 * lectores de la ficha (`getClusterFicha`, `loadDisplayFields`) viven aquí
 * también porque comparten el mismo mapeo PRN→registro fuente.
 *
 * SIN `db.transaction()` A PROPÓSITO (mismo criterio que person-records.ts y
 * patient-imports/apply.ts: el driver HTTP de Neon en Workers no admite
 * transacciones interactivas). `person_cluster_members` protege su invariante
 * ("un PRN vive en ≤1 cluster VIVO") con el índice parcial único
 * `idx_person_cluster_members_live` — el único punto de serialización real.
 * Cada escritura de este módulo es una máquina de estados idempotente:
 * INSERT con `ON CONFLICT (prn) WHERE removed_at IS NULL DO NOTHING`
 * (idioma de `services/patient-imports/apply.ts`, drizzle no tiene un target
 * probado para conflictos parciales en este repo) + re-lectura, nunca
 * SELECT-then-decide con ventana de carrera sin re-verificar.
 *
 * `recomputeClusterFor` es el ÚNICO escritor de `person_cluster_members` y de
 * `person_clusters.status`. Se le llama tras cada CONFIRMACIÓN y tras cada
 * UNMERGE (services/person-links.ts) y desde el cron de invariantes
 * (person-records.ts:runClusterInvariantChecks, vía person-links.ts).
 */
import { randomUUID, createHash } from "crypto";
import { and, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { colombiaTenantScope } from "@/lib/colombia-tenant";
import { incidentOwnership } from "@/tenant/ownership";

const {
  personLinks,
  personLinkDecisions,
  personClusters,
  personClusterMembers,
  personRecords,
  missingPersons,
  hospitalPatients,
  unidentifiedPersons,
  hospitals,
} = schema;

/** Mismo helper de una línea que candidates.ts/person-records.ts/missing.ts —
 *  normaliza el resultado de `db.execute()` entre el driver HTTP de Neon
 *  (array directo) y node-postgres (`{ rows }`). No se comparte entre
 *  archivos a propósito (es el idioma ya establecido en este repo). */
function execRows<T>(result: unknown): T[] {
  return (Array.isArray(result) ? result : (result as { rows: T[] }).rows) as T[];
}

/** Tope defensivo del tamaño de un componente conexo (BFS) — protege contra
 *  un ciclo de datos corruptos generando un componente sin fin. En volúmenes
 *  reales de fase 1 nunca se acerca a esto. */
const MAX_COMPONENT_SIZE = 2000;

/**
 * BFS sobre `person_links` CONFIRMADOS (solo) desde `seedPrn`. Devuelve el
 * componente conexo COMPLETO (incluye `seedPrn`, incluso si está aislado —
 * un Set de 1 elemento es un componente válido).
 */
export async function confirmedComponent(seedPrn: string): Promise<Set<string>> {
  const db = getDb();
  const visited = new Set<string>([seedPrn]);
  const queue: string[] = [seedPrn];

  while (queue.length > 0) {
    if (visited.size >= MAX_COMPONENT_SIZE) {
      console.error(
        `[person-clusters] confirmedComponent: componente desde ${seedPrn} superó ${MAX_COMPONENT_SIZE} PRNs; se corta (posible dato corrupto) — el cron de invariantes lo revisará.`,
      );
      break;
    }
    const current = queue.shift()!;
    const rows = execRows<{ prn_a: string; prn_b: string }>(
      await db.execute(sql`
        SELECT prn_a, prn_b FROM person_links
        WHERE status = 'confirmed' AND (prn_a = ${current} OR prn_b = ${current})
      `),
    );
    for (const row of rows) {
      const neighbor = row.prn_a === current ? row.prn_b : row.prn_a;
      if (!visited.has(neighbor)) {
        visited.add(neighbor);
        queue.push(neighbor);
      }
    }
  }
  return visited;
}

/** Cluster VIVO actual de un PRN (o null si no tiene membresía viva). */
export async function liveClusterOf(prn: string): Promise<string | null> {
  const db = getDb();
  const rows = execRows<{ cluster_id: string }>(
    await db.execute(sql`
      SELECT cluster_id FROM person_cluster_members WHERE prn = ${prn} AND removed_at IS NULL LIMIT 1
    `),
  );
  return rows[0]?.cluster_id ?? null;
}

/** PRNs con membresía VIVA en `clusterId`. */
export async function liveMembersOf(clusterId: string): Promise<string[]> {
  const db = getDb();
  const rows = execRows<{ prn: string }>(
    await db.execute(sql`
      SELECT prn FROM person_cluster_members WHERE cluster_id = ${clusterId} AND removed_at IS NULL
    `),
  );
  return rows.map((r) => r.prn);
}

/**
 * Cluster canónico (sub-paso 2 del algoritmo): el MÁS ANTIGUO (por
 * `created_at`, desempate por `id`) que tenga hoy al menos un miembro VIVO
 * del componente. `null` si ningún miembro del componente tiene cluster vivo
 * todavía (caso: componente completamente nuevo).
 */
async function findOldestLiveClusterAmong(component: Set<string>): Promise<string | null> {
  if (component.size === 0) return null;
  const db = getDb();
  const prns = [...component];
  const rows = execRows<{ cluster_id: string }>(
    await db.execute(sql`
      SELECT pcm.cluster_id AS cluster_id
      FROM person_cluster_members pcm
      JOIN person_clusters pc ON pc.id = pcm.cluster_id
      WHERE pcm.removed_at IS NULL AND pcm.prn IN (${sql.join(
        prns.map((p) => sql`${p}`),
        sql`, `,
      )})
      ORDER BY pc.created_at ASC, pc.id ASC
      LIMIT 1
    `),
  );
  return rows[0]?.cluster_id ?? null;
}

/**
 * Id DETERMINISTA para un cluster NUEVO (mismo idioma que
 * `apply.ts:deterministicPatientId`): hash del componente completo,
 * ordenado (el orden de inserción de un `Set` no es una clave estable entre
 * dos llamadas concurrentes que calcularon el mismo componente). Dos
 * `recomputeClusterFor` corriendo en paralelo sobre el MISMO componente
 * fresco calculan el MISMO id aquí — ver el comentario en `recomputeOne`
 * sobre por qué esto, y no `randomUUID()`, es lo que evita que dos
 * canónicos igual de "válidos" terminen en tira-y-afloja.
 */
function deterministicNewClusterId(component: Set<string>): string {
  const sorted = [...component].sort();
  const hex = createHash("sha256").update(`person-cluster:${sorted.join(",")}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Converge la membresía VIVA de `prn` al cluster `canonicalClusterId`
 * (sub-pasos 3+4 combinados, ver cabecera del módulo): si `prn` YA vive ahí,
 * no-op. Si vive en OTRO cluster (membresía "obsoleta"), la marca
 * `removed_at` (nunca DELETE — historia preservada) y reintenta. Si no tiene
 * membresía viva en ningún lado, intenta insertar en el canónico vía
 * `ON CONFLICT (prn) WHERE removed_at IS NULL DO NOTHING`.
 *
 * "Insert perdido = otro recompute corriendo en paralelo, re-leer en vez de
 * fallar": cada iteración vuelve a leer el estado real antes de decidir la
 * siguiente acción, así que una carrera con OTRO `recomputeClusterFor` nunca
 * produce un error — en el peor caso, unas pocas iteraciones de más hasta que
 * ambas corridas convergen al mismo cluster canónico (determinista: "el más
 * antiguo" es la misma respuesta para cualquiera que lo calcule con el mismo
 * componente).
 *
 * Devuelve el cluster del que se desalojó a `prn`, si hubo alguno (para que
 * el llamador sepa qué otros clusters quedaron "tocados" — sub-paso 5).
 */
async function ensureLiveMembership(
  prn: string,
  canonicalClusterId: string,
  actor: string,
): Promise<string | null> {
  const db = getDb();
  const ownership = incidentOwnership(colombiaTenantScope());
  let evictedFrom: string | null = null;
  const MAX_ATTEMPTS = 5;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const liveClusterId = await liveClusterOf(prn);
    if (liveClusterId === canonicalClusterId) return evictedFrom;

    if (liveClusterId !== null) {
      // Membresía viva en un cluster NO canónico: desalojar (removed_at, NO
      // delete). Condicionado a removed_at IS NULL para no pisar a otro
      // recompute que ya lo haya hecho en paralelo (no-op silencioso en ese
      // caso, no un error).
      await db.execute(sql`
        UPDATE person_cluster_members
        SET removed_at = ${Date.now()}
        WHERE prn = ${prn} AND cluster_id = ${liveClusterId} AND removed_at IS NULL
      `);
      evictedFrom = liveClusterId;
      continue; // re-lee en la siguiente vuelta; ahora debería estar libre.
    }

    // Sin membresía viva en ningún lado: intenta reclamar el canónico. El
    // índice parcial único es el árbitro; DO NOTHING si alguien más ganó la
    // carrera (se re-lee en la siguiente vuelta, nunca se lanza).
    await db.execute(sql`
      INSERT INTO person_cluster_members (id, cluster_id, prn, added_at, removed_at, added_by, organization_id, incident_id)
      VALUES (${randomUUID()}, ${canonicalClusterId}, ${prn}, ${Date.now()}, NULL, ${actor}, ${ownership.organizationId}, ${ownership.incidentId})
      ON CONFLICT (prn) WHERE removed_at IS NULL DO NOTHING
    `);
  }

  const finalCluster = await liveClusterOf(prn);
  if (finalCluster !== canonicalClusterId) {
    // Contención persistente (varias corridas concurrentes pisándose varias
    // veces seguidas) — se loguea y se deja: el cron de invariantes
    // (runClusterInvariantChecks) es la red de seguridad final.
    console.error(
      `[person-clusters] ensureLiveMembership: ${prn} no convergió a ${canonicalClusterId} tras ${MAX_ATTEMPTS} intentos; el cron de invariantes lo reparará.`,
    );
  }
  return evictedFrom;
}

/** 'located_hospital' si CUALQUIER miembro del componente resuelve a
 *  hospital_patient; si no, 'reported_missing' (mínimo de fase 1). */
async function deriveClusterStatus(
  component: Set<string>,
): Promise<"located_hospital" | "reported_missing"> {
  if (component.size === 0) return "reported_missing";
  const db = getDb();
  const prns = [...component];
  const rows = execRows<{ record_type: string }>(
    await db.execute(sql`
      SELECT record_type FROM person_records
      WHERE record_type = 'hospital_patient' AND prn IN (${sql.join(
        prns.map((p) => sql`${p}`),
        sql`, `,
      )})
      LIMIT 1
    `),
  );
  return rows.length > 0 ? "located_hospital" : "reported_missing";
}

export interface RecomputeClusterResult {
  clusterId: string;
  status: "located_hospital" | "reported_missing";
}

/**
 * Un paso de convergencia PARA UN SOLO PRN (sub-pasos 1-4 + estado): calcula
 * su componente confirmado, decide/crea el cluster canónico, converge la
 * membresía de TODO el componente a ese canónico, y deriva+escribe el
 * status. Devuelve también qué otros clusters quedaron "tocados" (de donde
 * se desalojó a algún miembro) y qué PRNs del componente terminaron
 * desalojados de vuelta a la cola (sub-paso 5, lo resuelve el llamador).
 */
async function recomputeOne(
  prn: string,
): Promise<{ outcome: RecomputeClusterResult; component: Set<string>; touchedClusterIds: Set<string> }> {
  const db = getDb();
  const component = await confirmedComponent(prn);

  let canonicalClusterId = await findOldestLiveClusterAmong(component);
  if (!canonicalClusterId) {
    // Id DETERMINISTA (mismo idioma que apply.ts:deterministicPatientId) —
    // NO randomUUID(). Dos `recomputeClusterFor` concurrentes sobre el MISMO
    // componente fresco (sin cluster previo) calculan el MISMO id aquí, así
    // que `ON CONFLICT (id) DO NOTHING` los hace converger a UNA sola fila
    // de `person_clusters` sin importar cuál "gane" — sin esto, cada uno
    // crearía su PROPIO cluster nuevo con un id aleatorio distinto, y el
    // reintento de `ensureLiveMembership` (que sí resuelve la membresía)
    // terminaría en un tira-y-afloja entre dos canónicos igual de "válidos"
    // en vez de converger limpio a uno solo.
    canonicalClusterId = deterministicNewClusterId(component);
    await db
      .insert(personClusters)
      .values({
        id: canonicalClusterId,
        status: "reported_missing",
        createdAt: Date.now(),
        ...incidentOwnership(colombiaTenantScope()),
      })
      .onConflictDoNothing();
  }

  const touchedClusterIds = new Set<string>([canonicalClusterId]);
  for (const member of component) {
    const evictedFrom = await ensureLiveMembership(member, canonicalClusterId, "system");
    if (evictedFrom) touchedClusterIds.add(evictedFrom);
  }

  // Verificación-tras-escritura: re-lee cada miembro; una divergencia
  // (contención muy persistente) se reintenta UNA vez más inline; si sigue
  // divergente, se loguea y se deja al cron de invariantes (nunca se lanza:
  // esta es una operación de mejor esfuerzo que corre dentro del flujo de
  // decisión del revisor, no debe tumbar su request).
  for (const member of component) {
    const live = await liveClusterOf(member);
    if (live !== canonicalClusterId) {
      const evictedFrom = await ensureLiveMembership(member, canonicalClusterId, "system");
      if (evictedFrom) touchedClusterIds.add(evictedFrom);
      const after = await liveClusterOf(member);
      if (after !== canonicalClusterId) {
        console.error(
          `[person-clusters] recomputeClusterFor: ${member} sigue sin converger a ${canonicalClusterId} tras reintento; el cron de invariantes lo reparará.`,
        );
      }
    }
  }

  const status = await deriveClusterStatus(component);
  await db.execute(sql`
    UPDATE person_clusters SET status = ${status} WHERE id = ${canonicalClusterId} AND status <> ${status}
  `);

  return { outcome: { clusterId: canonicalClusterId, status }, component, touchedClusterIds };
}

/** Tope duro de la cola de desalojo (sub-paso 5) — circuit breaker para datos
 *  patológicos; el resto queda para el cron de invariantes (cadencia lenta,
 *  con su propio presupuesto de tiempo). En un merge/unmerge real de fase 1
 *  esto nunca se acerca. */
const MAX_EVICTION_QUEUE = 500;

/**
 * Converge la membresía de cluster para `seedPrn` (los 5 sub-pasos del
 * algoritmo — ver docstring de más arriba y el plan U9). Idempotente:
 * correrla dos veces seguidas sin cambios de por medio es un no-op (mismo
 * componente, mismo canónico, ninguna membresía que mover).
 *
 * Sub-paso 5 (EVICT BEYOND THE SEED) implementado como cola iterativa
 * acotada, NO recursión: tras converger al seed, se enumeran los miembros
 * vivos de cada cluster TOCADO (el canónico + cualquiera del que se
 * desalojó a alguien) y cualquiera que NO esté en el componente recién
 * calculado se encola para su PROPIO recompute. Dos garantías de
 * terminación, no una: (a) un `visited` de PRNs ya procesados EN ESTA
 * llamada — cada PRN se recomputa como máximo una vez por invocación, así
 * que la cola drena en, a lo sumo, tantos pasos como PRNs distintos toque la
 * cascada; (b) `MAX_EVICTION_QUEUE` como interruptor duro para datos
 * patológicos, que corta la corrida y deja el resto al cron de invariantes
 * (que tiene su propio presupuesto de tiempo y corre en cadencia). Sin esto,
 * un unmerge que encoge un cluster fusionado dejaría miembros inalcanzables
 * "varados" en el cluster viejo.
 */
export async function recomputeClusterFor(seedPrn: string): Promise<RecomputeClusterResult> {
  const db = getDb();
  const visited = new Set<string>([seedPrn]);
  const first = await recomputeOne(seedPrn);
  const seedResult = first.outcome;

  const queue: string[] = [];

  // Encola cualquier miembro VIVO de un cluster "tocado" que NO pertenezca
  // al componente recién calculado — el sub-paso 5 (EVICT BEYOND THE SEED).
  //
  // CRÍTICO: además de encolarlos, esta función los DESALOJA (removed_at) del
  // cluster tocado AQUÍ MISMO, antes de que corra su propio recompute. Sin
  // esto, el recompute individual de un miembro varado vería que TODAVÍA
  // tiene una membresía viva en el cluster viejo y (paso 2: "el canónico es
  // el cluster más antiguo que tenga un miembro VIVO del componente")
  // "heredaría" ese mismo cluster viejo como su propio canónico — sin
  // moverse a ningún lado. Es exactamente el caso merge→unmerge: tras
  // deshacer B-C, C y D deben terminar en un cluster PROPIO nuevo, no
  // seguir viviendo en el cluster fusionado solo porque nadie los movió
  // todavía. Desalojar TODOS los varados de una vez (antes de recomputar a
  // NINGUNO) también evita que un varado "herede" el cluster viejo viendo a
  // un HERMANO varado que aún no se movió.
  async function collectStranded(touchedClusterIds: Set<string>, component: Set<string>): Promise<void> {
    const strays: { prn: string; clusterId: string }[] = [];
    for (const clusterId of touchedClusterIds) {
      const liveMembers = await liveMembersOf(clusterId);
      for (const member of liveMembers) {
        if (!component.has(member)) strays.push({ prn: member, clusterId });
      }
    }
    if (strays.length === 0) return;

    const now = Date.now();
    for (const stray of strays) {
      await db.execute(sql`
        UPDATE person_cluster_members
        SET removed_at = ${now}
        WHERE prn = ${stray.prn} AND cluster_id = ${stray.clusterId} AND removed_at IS NULL
      `);
    }
    for (const stray of strays) {
      if (!visited.has(stray.prn) && !queue.includes(stray.prn)) queue.push(stray.prn);
    }
  }

  await collectStranded(first.touchedClusterIds, first.component);

  let guard = 0;
  while (queue.length > 0) {
    if (++guard > MAX_EVICTION_QUEUE) {
      console.error(
        `[person-clusters] recomputeClusterFor: cola de desalojo desde seed=${seedPrn} superó ${MAX_EVICTION_QUEUE} PRNs; corrida truncada (el cron de invariantes cierra el resto).`,
      );
      break;
    }
    const next = queue.shift()!;
    if (visited.has(next)) continue;
    visited.add(next);
    const step = await recomputeOne(next);
    await collectStranded(step.touchedClusterIds, step.component);
  }

  return seedResult;
}

// --------------------------------------------------------------- lecturas ---

/** Info de "anclaje" de un lado de un vínculo (R18): usada por
 *  services/person-links.ts para decidir si una confirmación es una fusión
 *  ANCLADA (ver docstring de `isAnchoredMerge`). */
interface AnchorInfo {
  clusterId: string | null;
  liveMemberCount: number;
  confirmedLinkCount: number;
}

async function countConfirmedLinksExcluding(prn: string, excludeLinkId: string): Promise<number> {
  const db = getDb();
  const rows = execRows<{ n: number }>(
    await db.execute(sql`
      SELECT count(*)::int AS n FROM person_links
      WHERE status = 'confirmed' AND id <> ${excludeLinkId} AND (prn_a = ${prn} OR prn_b = ${prn})
    `),
  );
  return rows[0]?.n ?? 0;
}

async function anchorInfoFor(prn: string, excludeLinkId: string): Promise<AnchorInfo> {
  const clusterId = await liveClusterOf(prn);
  const liveMemberCount = clusterId ? (await liveMembersOf(clusterId)).length : 0;
  const confirmedLinkCount = await countConfirmedLinksExcluding(prn, excludeLinkId);
  return { clusterId, liveMemberCount, confirmedLinkCount };
}

function isAnchored(info: AnchorInfo): boolean {
  return info.liveMemberCount >= 2 || info.confirmedLinkCount >= 1;
}

/**
 * "Fusión anclada" (R18): confirmar el vínculo `excludeLinkId` entre `prnA` y
 * `prnB` uniría DOS clusters que YA tienen identidad propia — cada lado
 * tiene ≥2 miembros vivos O ≥1 vínculo confirmado ADEMÁS de este (esto
 * último cubre el caso en que la membresía materializada aún no alcanzó al
 * `person_links` recién confirmado — la fuente de verdad de "¿ya tenía
 * anclaje?" es `person_links`, no el cluster materializado, que puede ir un
 * paso detrás bajo concurrencia).
 *
 * Si ambos lados ya materializan el MISMO cluster, esto NO es una fusión
 * nueva (ya están juntos) — no cuenta como anclada aunque cada lado sea
 * grande.
 */
export async function isAnchoredMerge(
  prnA: string,
  prnB: string,
  excludeLinkId: string,
): Promise<boolean> {
  const [a, b] = await Promise.all([
    anchorInfoFor(prnA, excludeLinkId),
    anchorInfoFor(prnB, excludeLinkId),
  ]);
  if (!isAnchored(a) || !isAnchored(b)) return false;
  if (a.clusterId && b.clusterId && a.clusterId === b.clusterId) return false;
  return true;
}

/**
 * Campos de presentación de UN registro fuente (allowlist, sin PII cruda más
 * allá de nombre/edad — mismos campos que ya son públicos en sus DTOs
 * propios de missing.ts/patients.ts). `population` = la población de origen
 * (mismo vocabulario que `POPULATIONS` en person-records.ts:
 * missing_report|hospital_patient|unidentified_person); `source` es un dato
 * de PROCEDENCIA legible (nombre del hospital para un paciente, el campo
 * `source` externo para un reporte, vacío para no-identificados — no tienen
 * concepto de procedencia). `outcome` lleva el literal "registro eliminado"
 * cuando el registro fuente fue tombstoneado (U10) — en ese caso name/age/
 * source se devuelven vacíos/null a propósito (el registro ya no existe,
 * mostrar sus últimos valores sería engañoso).
 */
export interface RecordDisplay {
  prn: string;
  recordType: string;
  name: string;
  age: number | null;
  population: string;
  source: string;
  outcome: "registro eliminado" | null;
  /** Cluster VIVO de este PRN hoy, si tiene. */
  clusterId: string | null;
}

/** Carga campos de presentación para un lote de PRNs, en 4 queries batched
 *  (person_records + las 3 tablas fuente + hospitals para el nombre del
 *  hospital) en vez de N+1. PRNs sin registro (no deberían existir salvo
 *  dato corrupto) se omiten silenciosamente del mapa devuelto. */
export async function loadDisplayFields(prns: string[]): Promise<Map<string, RecordDisplay>> {
  const out = new Map<string, RecordDisplay>();
  if (prns.length === 0) return out;
  const db = getDb();

  const refs = await db
    .select({
      prn: personRecords.prn,
      recordType: personRecords.recordType,
      recordId: personRecords.recordId,
      removedAt: personRecords.removedAt,
    })
    .from(personRecords)
    .where(inArray(personRecords.prn, prns));
  if (refs.length === 0) return out;

  const liveClusterRows = await db
    .select({ prn: personClusterMembers.prn, clusterId: personClusterMembers.clusterId })
    .from(personClusterMembers)
    .where(and(inArray(personClusterMembers.prn, prns), isNull(personClusterMembers.removedAt)));
  const liveClusterByPrn = new Map(liveClusterRows.map((r) => [r.prn, r.clusterId]));

  const missingIds = refs.filter((r) => r.recordType === "missing_report").map((r) => r.recordId);
  const patientIds = refs.filter((r) => r.recordType === "hospital_patient").map((r) => r.recordId);
  const unidentifiedIds = refs
    .filter((r) => r.recordType === "unidentified_person")
    .map((r) => r.recordId);

  async function fetchMissingRows(): Promise<
    Array<{ id: string; name: string; age: number | null; source: string | null }>
  > {
    if (missingIds.length === 0) return [];
    return db
      .select({ id: missingPersons.id, name: missingPersons.name, age: missingPersons.age, source: missingPersons.source })
      .from(missingPersons)
      .where(inArray(missingPersons.id, missingIds));
  }

  async function fetchPatientRows(): Promise<
    Array<{ id: string; name: string; age: number | null; hospitalId: string }>
  > {
    if (patientIds.length === 0) return [];
    return db
      .select({
        id: hospitalPatients.id,
        name: hospitalPatients.name,
        age: hospitalPatients.age,
        hospitalId: hospitalPatients.hospitalId,
      })
      .from(hospitalPatients)
      .where(inArray(hospitalPatients.id, patientIds));
  }

  async function fetchUnidentifiedRows(): Promise<
    Array<{ id: string; name: string; surname: string }>
  > {
    if (unidentifiedIds.length === 0) return [];
    return db
      .select({ id: unidentifiedPersons.id, name: unidentifiedPersons.name, surname: unidentifiedPersons.surname })
      .from(unidentifiedPersons)
      .where(inArray(unidentifiedPersons.id, unidentifiedIds));
  }

  const [missingRows, patientRows, unidentifiedRows] = await Promise.all([
    fetchMissingRows(),
    fetchPatientRows(),
    fetchUnidentifiedRows(),
  ]);

  const hospitalIds = [...new Set(patientRows.map((p) => p.hospitalId))];
  const hospitalRows = hospitalIds.length
    ? await db.select({ id: hospitals.id, name: hospitals.name }).from(hospitals).where(inArray(hospitals.id, hospitalIds))
    : [];
  const hospitalNameById = new Map(hospitalRows.map((h) => [h.id, h.name]));

  const missingById = new Map(missingRows.map((r) => [r.id, r]));
  const patientById = new Map(patientRows.map((r) => [r.id, r]));
  const unidentifiedById = new Map(unidentifiedRows.map((r) => [r.id, r]));

  for (const ref of refs) {
    const removed = ref.removedAt !== null;
    let name = "";
    let age: number | null = null;
    let source = "";

    if (!removed) {
      if (ref.recordType === "missing_report") {
        const row = missingById.get(ref.recordId);
        name = row?.name ?? "";
        age = row?.age ?? null;
        source = row?.source ?? "";
      } else if (ref.recordType === "hospital_patient") {
        const row = patientById.get(ref.recordId);
        name = row?.name ?? "";
        age = row?.age ?? null;
        source = row ? (hospitalNameById.get(row.hospitalId) ?? "") : "";
      } else if (ref.recordType === "unidentified_person") {
        const row = unidentifiedById.get(ref.recordId);
        name = row ? [row.name, row.surname].filter(Boolean).join(" ").trim() : "";
      }
    }

    out.set(ref.prn, {
      prn: ref.prn,
      recordType: ref.recordType,
      name,
      age,
      population: ref.recordType,
      source,
      outcome: removed ? "registro eliminado" : null,
      clusterId: liveClusterByPrn.get(ref.prn) ?? null,
    });
  }
  return out;
}

export interface DecisionHistoryEntryDTO {
  id: string;
  linkId: string;
  prnA: string;
  prnB: string;
  decision: string;
  note: string;
  evidenceSnapshot: unknown;
  decidedBy: string;
  decidedAt: number;
}

/** Historia de decisiones (person_link_decisions) de todos los vínculos que
 *  tocan cualquiera de `prns`, más reciente primero. */
export async function loadDecisionsForPrns(prns: string[]): Promise<DecisionHistoryEntryDTO[]> {
  if (prns.length === 0) return [];
  const db = getDb();
  const links = await db
    .select({ id: personLinks.id, prnA: personLinks.prnA, prnB: personLinks.prnB })
    .from(personLinks)
    .where(or(inArray(personLinks.prnA, prns), inArray(personLinks.prnB, prns)));
  if (links.length === 0) return [];

  const linkById = new Map(links.map((l) => [l.id, l]));
  const decisions = await db
    .select()
    .from(personLinkDecisions)
    .where(
      inArray(
        personLinkDecisions.linkId,
        links.map((l) => l.id),
      ),
    )
    .orderBy(desc(personLinkDecisions.decidedAt));

  return decisions.map((d) => {
    const link = linkById.get(d.linkId)!;
    return {
      id: d.id,
      linkId: d.linkId,
      prnA: link.prnA,
      prnB: link.prnB,
      decision: d.decision,
      note: d.note,
      evidenceSnapshot: d.evidenceSnapshot,
      decidedBy: d.decidedBy,
      decidedAt: d.decidedAt,
    };
  });
}

export interface ClusterMemberFichaDTO extends RecordDisplay {
  addedAt: number;
  /** null = membresía viva; no-null = histórica (nunca se borra, ver R13). */
  removedAt: number | null;
  addedBy: string;
}

export interface ClusterFichaDTO {
  clusterId: string;
  status: string;
  createdAt: number;
  /** Historia COMPLETA de membresía (vivos + desalojados) — R13: "membership
   *  history preserved". */
  members: ClusterMemberFichaDTO[];
  /** Decisiones de todos los vínculos que tocan a los miembros VIVOS de hoy. */
  decisions: DecisionHistoryEntryDTO[];
}

/** Ficha de un cluster para el panel de revisión: miembros (con historia) +
 *  historia de decisiones + status. `null` si el cluster no existe. */
export async function getClusterFicha(clusterId: string): Promise<ClusterFichaDTO | null> {
  const db = getDb();
  const clusterRows = await db.select().from(personClusters).where(eq(personClusters.id, clusterId)).limit(1);
  const cluster = clusterRows[0];
  if (!cluster) return null;

  const memberRows = await db
    .select()
    .from(personClusterMembers)
    .where(eq(personClusterMembers.clusterId, clusterId))
    .orderBy(personClusterMembers.addedAt);

  const displays = await loadDisplayFields(memberRows.map((m) => m.prn));
  const emptyDisplay = (prn: string): RecordDisplay => ({
    prn,
    recordType: "",
    name: "",
    age: null,
    population: "",
    source: "",
    outcome: null,
    clusterId: null,
  });

  const members: ClusterMemberFichaDTO[] = memberRows.map((m) => ({
    ...(displays.get(m.prn) ?? emptyDisplay(m.prn)),
    addedAt: m.addedAt,
    removedAt: m.removedAt,
    addedBy: m.addedBy,
  }));

  const livePrns = memberRows.filter((m) => m.removedAt === null).map((m) => m.prn);
  const decisions = await loadDecisionsForPrns(livePrns);

  return { clusterId: cluster.id, status: cluster.status, createdAt: cluster.createdAt, members, decisions };
}
