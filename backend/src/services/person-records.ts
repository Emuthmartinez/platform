/**
 * Registro de PRNs (`person_records`) — U7. El overlay de identidad NUNCA
 * modifica las tablas fuente (missing_persons, hospital_patients,
 * unidentified_persons): este service es el ÚNICO lugar que lee/escribe
 * `person_records`.
 *
 * Dos caminos escriben, y comparten la MISMA disciplina de inserción
 * (`INSERT ... ON CONFLICT (record_type, record_id) DO NOTHING RETURNING`,
 * vía `stampBatch`) para que no puedan divergir (KTD8):
 *   1. `ensurePrn` — best-effort, inline, tras el insert de cada camino de
 *      creación (missing.ts, patients.ts, ...). Nunca falla el write padre.
 *   2. `reconcilePersonRecords` — el cron de backfill/reconciliación. Sus
 *      primeras corridas SON el backfill de lo que ya existía; en régimen
 *      permanente es la red de seguridad para la carrera del camino inline
 *      (dos escrituras concurrentes al mismo record_id antes de que la
 *      primera termine de estampar).
 *
 * Sin `db.transaction()` a propósito (prohibido en `src/**`: el driver HTTP
 * de Neon en Workers no soporta transacciones interactivas). Cada escritura
 * es una máquina de estados idempotente: ON CONFLICT DO NOTHING + reintento
 * ante colisión de PK, nunca SELECT-then-INSERT con lock.
 */
import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { generatePrn, normalizePrn } from "@/lib/prn";
import { getQueueProducer, type QueueProducer } from "@/lib/job-dispatch";
import { recomputeClusterFor } from "@/services/person-clusters";
import { colombiaTenantScope } from "@/lib/colombia-tenant";
import {
  incidentOwnership,
  sqlOwnsIncidentOrLegacyNull,
  tenantJobFields,
} from "@/tenant/ownership";
import type { TenantScope } from "@/tenant/scope";

const { personRecords, personLinks, personClusterMembers } = schema;

/** Máximo de reintentos ante colisión de PK (`person_records.prn`) — KTD7:
 *  astronómicamente improbable (8 símbolos de 32^8 combinaciones), pero el
 *  codec es puro y no puede garantizar unicidad por sí solo. */
const MAX_COLLISION_RETRIES = 3;

/**
 * Normaliza el resultado de `getDb().execute()` a un arreglo de filas — el
 * driver neon-http devuelve el arreglo directo; node-postgres devuelve
 * `{ rows }`. Mismo helper que `services/missing.ts` (no se importa de ahí:
 * es una función de una línea, y ese archivo no expone la suya).
 */
function execRows<T>(result: unknown): T[] {
  return (Array.isArray(result) ? result : (result as { rows: T[] }).rows) as T[];
}

/**
 * ¿El error es una violación de unicidad de Postgres (23505)? Drizzle envuelve
 * el error del driver en `DrizzleQueryError`, con el `code` real en `cause`
 * (a veces varios niveles adentro) — recorrer la cadena cubre ambas formas.
 * Mismo idioma que `public-api/resources/patients.resource.ts`.
 */
function isUniqueViolation(err: unknown): boolean {
  let current: unknown = err;
  for (let depth = 0; depth < 4 && typeof current === "object" && current !== null; depth++) {
    if ((current as { code?: string }).code === "23505") return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * Intenta insertar un lote de `(recordType, id)` con PRNs nuevos, vía UN
 * único INSERT multi-fila (`ON CONFLICT (record_type, record_id) DO NOTHING
 * RETURNING`). Es el ÚNICO camino de escritura a `person_records` — tanto
 * `ensurePrn` (lote de 1) como `reconcilePersonRecords` (lotes grandes) pasan
 * por aquí, así que no hay dos disciplinas de inserción que puedan divergir.
 *
 * Colisión de PK (`prn` ya existe — rarísimo): el INSERT multi-fila es
 * atómico, así que UNA sola colisión aborta el lote entero; se reintenta el
 * LOTE COMPLETO con PRNs nuevos para todas las filas, hasta
 * `MAX_COLLISION_RETRIES` veces. Cualquier otro error se propaga.
 *
 * Devuelve SOLO las filas que este llamador insertó de verdad (el RETURNING
 * set) — las que ya existían (perdieron la carrera de ON CONFLICT DO
 * NOTHING, o ya estaban estampadas de antes) no aparecen aquí. Quien necesite
 * el PRN de una fila ya existente usa `resolvePrn` o vuelve a leer.
 */
async function stampBatch(
  recordType: string,
  ids: readonly string[],
  now: number,
  scope: TenantScope = colombiaTenantScope(),
): Promise<Array<{ id: string; prn: string }>> {
  if (ids.length === 0) return [];
  const db = getDb();
  const ownership = incidentOwnership(scope);

  for (let attempt = 0; attempt < MAX_COLLISION_RETRIES; attempt++) {
    const tuples = ids.map(
      (id) =>
        sql`(${generatePrn()}, ${recordType}, ${id}, ${now}, ${ownership.organizationId}, ${ownership.incidentId})`,
    );
    try {
      const out = await db.execute(sql`
        INSERT INTO person_records (prn, record_type, record_id, created_at, organization_id, incident_id)
        VALUES ${sql.join(tuples, sql`,`)}
        ON CONFLICT (record_type, record_id) DO NOTHING
        RETURNING prn, record_id AS id
      `);
      return execRows<{ id: string; prn: string }>(out);
    } catch (err) {
      if (isUniqueViolation(err)) continue; // colisión de PK -> reintenta con PRNs nuevos
      throw err;
    }
  }

  throw new Error(
    `person-records: colisión de PRN persistente tras ${MAX_COLLISION_RETRIES} intentos ` +
      `(record_type="${recordType}", ${ids.length} fila(s)).`,
  );
}

/**
 * Garantiza que `(recordType, recordId)` tenga un PRN, creándolo si hace
 * falta. Idempotente: llamarla dos veces para el mismo registro deja UNA
 * sola fila (la segunda llamada pierde el ON CONFLICT y simplemente lee la
 * que ya existe).
 *
 * BEST-EFFORT a propósito (KTD8): se llama DESPUÉS del insert del camino de
 * creación (missing.ts, patients.ts, ...) y NUNCA debe tumbar esa escritura
 * ya confirmada. Cualquier fallo se loguea y devuelve `null` — el registro
 * queda sin PRN hasta que `reconcilePersonRecords` lo recoja en su próxima
 * corrida.
 */
export async function ensurePrn(
  recordType: string,
  recordId: string,
  scope: TenantScope = colombiaTenantScope(),
): Promise<string | null> {
  try {
    await stampBatch(recordType, [recordId], Date.now(), scope);
    const db = getDb();
    const rows = execRows<{ prn: string }>(
      await db.execute(sql`
        SELECT prn FROM person_records
        WHERE record_type = ${recordType} AND record_id = ${recordId}
        LIMIT 1
      `),
    );
    return rows[0]?.prn ?? null;
  } catch (err) {
    console.error(
      `[person-records] ensurePrn best-effort falló para record_type="${recordType}" ` +
        `record_id="${recordId}":`,
      err,
    );
    return null;
  }
}

/**
 * Versión en LOTE de `ensurePrn` (U14/KTD18): garantiza PRN para VARIOS
 * `(recordType, id)` a la vez con DOS round-trips totales (nunca uno por
 * registro) — el mismo `stampBatch` de arriba (UN INSERT multi-fila con `ON
 * CONFLICT DO NOTHING RETURNING`) + UN SOLO `SELECT ... IN (...)` para el
 * remanente que perdió el conflicto (ya tenía PRN de antes). Mismo contrato
 * best-effort que `ensurePrn`: nunca lanza, devuelve lo que alcanzó a
 * resolver (parcial ante un fallo a mitad de camino) — el caller decide qué
 * hacer con los ids que quedaron sin entrada en el mapa devuelto (p.ej.
 * `upsertExternalMissingBatch` simplemente no crea señal para esa fila; la
 * red de seguridad es `reconcilePersonRecords`).
 */
export async function ensurePrns(
  recordType: string,
  recordIds: readonly string[],
  scope: TenantScope = colombiaTenantScope(),
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const ids = [...new Set(recordIds)];
  if (ids.length === 0) return out;

  try {
    const stamped = await stampBatch(recordType, ids, Date.now(), scope);
    for (const row of stamped) out.set(row.id, row.prn);

    const remaining = ids.filter((id) => !out.has(id));
    if (remaining.length > 0) {
      const db = getDb();
      const rows = execRows<{ id: string; prn: string }>(
        await db.execute(sql`
          SELECT record_id AS id, prn FROM person_records
          WHERE record_type = ${recordType} AND record_id IN (${sql.join(
            remaining.map((id) => sql`${id}`),
            sql`,`,
          )})
        `),
      );
      for (const row of rows) out.set(row.id, row.prn);
    }
    return out;
  } catch (err) {
    console.error(
      `[person-records] ensurePrns best-effort falló para record_type="${recordType}" ` +
        `(${ids.length} fila(s)):`,
      err,
    );
    return out;
  }
}

/** A qué registro fuente apunta un PRN, o `null` si el PRN no existe. */
export interface PersonRecordRef {
  recordType: string;
  recordId: string;
  /** Tombstone (U10): no-null cuando el registro fuente fue borrado. */
  removedAt: number | null;
}

/**
 * Resuelve un PRN a su registro fuente. Acepta cualquier forma tolerada por
 * `normalizePrn` (mayúsculas/minúsculas, alias I/L/O, guiones opcionales) —
 * quien busca por PRN no necesita transcribirlo exacto.
 */
export async function resolvePrn(prn: string): Promise<PersonRecordRef | null> {
  const canonical = normalizePrn(prn);
  if (!canonical) return null;

  const db = getDb();
  const rows = await db
    .select({
      recordType: personRecords.recordType,
      recordId: personRecords.recordId,
      removedAt: personRecords.removedAt,
    })
    .from(personRecords)
    .where(eq(personRecords.prn, canonical))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Estados "vivos" de `person_links` — cualquiera se rescinde cuando el
 * registro fuente en uno de sus dos extremos se tombstonea (ver
 * `tombstonePersonRecord`). MISMO catálogo que `LIVE_LINK_STATUSES` de
 * `services/person-links.ts`, duplicado a propósito: un import ESTÁTICO de
 * vuelta hacia ese archivo sería un ciclo real — mismo motivo por el que
 * `runClusterInvariantChecks` (más abajo) ya importa ese módulo de forma
 * DINÁMICA.
 */
const LIVE_LINK_STATUSES = ["proposed", "unsure", "confirmed"] as const;

export interface TombstoneResult {
  /** PRN del registro tombstoneado — `null` si el registro nunca tuvo uno
   *  estampado (ensurePrn/reconcile aún no lo alcanzaron, o backend sin capa
   *  de identidad todavía). */
  prn: string | null;
}

/**
 * Tombstone de identidad (U10, R21/AE3). Se llama SIEMPRE desde la capa de
 * ROUTER —nunca desde otro service— ANTES del borrado físico del registro
 * fuente: mismo orden "insert-before-mutate" que las suppressions de
 * `services/missing.ts:removeMissing`. Sitios de llamada: la ruta DELETE
 * hecha a mano de `routes/missing.ts`, y el hook `onBeforeRemove` de la
 * fábrica CRUD (`missing.resource.ts` / `patients.resource.ts`).
 *
 * BEST-EFFORT A PROPÓSITO (mismo espíritu que `ensurePrn`): NUNCA lanza — el
 * borrado del registro fuente no debe bloquearse por un hiccup de la capa de
 * identidad. Cualquier fallo se loguea; `runClusterInvariantChecks` (KTD8) es
 * la red de seguridad que repara cualquier divergencia que esto deje a medias.
 *
 * Sin PRN (nunca estampado) → no-op, éxito (`{ prn: null }`). Ya tombstoneado
 * (`removed_at` no nulo) → no-op idempotente, éxito (mismo `prn`, nada se
 * repite).
 *
 * Orden de los pasos —la parte que importa (hallazgo de la revisión
 * adversarial del plan): borrar un VÉRTICE puede partir su componente
 * confirmado en tantos fragmentos como vecinos confirmados tenía.
 *   1. Captura el conjunto de vecinos por link CONFIRMADO ANTES de rescindir
 *      nada — después de rescindir ya no queda ningún link confirmado que
 *      mirar.
 *   2. Rescinde TODOS los links vivos (proposed/unsure/confirmed, no solo los
 *      confirmados) que tocan este PRN → 'rejected' + una fila de decisión
 *      'rescinded' por cada uno, atribuida a `actorId`. Reusa
 *      `rescindLiveLink` de `person-links.ts` (import DINÁMICO — mismo motivo
 *      de ciclo que `runClusterInvariantChecks`) en vez de duplicar el INSERT
 *      de `person_link_decisions`.
 *   3. Desaloja la membresía VIVA propia del cluster: `removed_at` directo
 *      (NUNCA vía `recomputeClusterFor` sobre este mismo PRN — tras el paso 2
 *      ya no tiene vínculos vivos, así que recomputarlo lo materializaría en
 *      un cluster NUEVO de un solo miembro en vez de simplemente salir).
 *      Historia preservada (nunca DELETE), mismo idioma que
 *      `person-clusters.ts`.
 *   4. Marca `person_records.removed_at`.
 *   5. `recomputeClusterFor` para CADA vecino capturado en el paso 1 — no
 *      basta con uno solo ("one BFS from a single survivor is NOT enough"):
 *      cada fragmento del componente partido retiene al menos un vecino de la
 *      lista original, así que recorrerlos TODOS es la única cobertura
 *      completa garantizada.
 *   6. Sweep del matcher para esos mismos vecinos — ahora que este registro
 *      ya no está en el camino, podrían emparejar contra otro candidato.
 */
export async function tombstonePersonRecord(
  recordType: string,
  recordId: string,
  actorId: string,
): Promise<TombstoneResult> {
  let resolvedPrn: string | null = null;
  try {
    const db = getDb();
    const rows = await db
      .select({ prn: personRecords.prn, removedAt: personRecords.removedAt })
      .from(personRecords)
      .where(
        and(eq(personRecords.recordType, recordType), eq(personRecords.recordId, recordId)),
      )
      .limit(1);
    const ref = rows[0];
    if (!ref) return { prn: null }; // nunca estampado -> no-op

    const prn = ref.prn;
    resolvedPrn = prn;
    if (ref.removedAt !== null) return { prn }; // ya tombstoneado -> no-op idempotente

    // 1. Vecinos por link CONFIRMADO — ANTES de tocar nada.
    const neighborRows = await db
      .select({ prnA: personLinks.prnA, prnB: personLinks.prnB })
      .from(personLinks)
      .where(
        and(eq(personLinks.status, "confirmed"), or(eq(personLinks.prnA, prn), eq(personLinks.prnB, prn))),
      );
    const formerNeighbors = new Set<string>();
    for (const row of neighborRows) {
      formerNeighbors.add(row.prnA === prn ? row.prnB : row.prnA);
    }

    // 2. Rescinde TODOS los links vivos que tocan este PRN (reusa
    // rescindLiveLink de person-links.ts — no duplica el insert de decisión).
    const { rescindLiveLink } = await import("@/services/person-links");
    const liveLinkRows = await db
      .select({ id: personLinks.id })
      .from(personLinks)
      .where(
        and(
          inArray(personLinks.status, [...LIVE_LINK_STATUSES]),
          or(eq(personLinks.prnA, prn), eq(personLinks.prnB, prn)),
        ),
      );
    for (const link of liveLinkRows) {
      await rescindLiveLink(link.id, actorId, "person.purge: registro fuente eliminado.");
    }

    // 3. Desaloja la membresía viva propia (directo — sin recompute; ver
    // docstring). Historia preservada: removed_at, jamás DELETE.
    await db
      .update(personClusterMembers)
      .set({ removedAt: Date.now() })
      .where(and(eq(personClusterMembers.prn, prn), isNull(personClusterMembers.removedAt)));

    // 4. Tombstone del registro.
    await db.update(personRecords).set({ removedAt: Date.now() }).where(eq(personRecords.prn, prn));

    // 5. Recompute para CADA vecino — cut-vertex: uno solo no basta.
    for (const neighbor of formerNeighbors) {
      await recomputeClusterFor(neighbor);
    }

    // 6. Sweep del matcher para los mismos vecinos.
    if (formerNeighbors.size > 0) {
      await enqueueMatcherSweep([...formerNeighbors]);
    }

    return { prn };
  } catch (err) {
    console.error(
      `[person-records] tombstonePersonRecord best-effort falló para record_type="${recordType}" ` +
        `record_id="${recordId}":`,
      err,
    );
    return { prn: resolvedPrn };
  }
}

/**
 * Las tres poblaciones fuente que este backfill/cron cubre (R8). Catálogo
 * cerrado e interno — nunca viene de una request, así que `sql.raw()` sobre
 * `table` en `listUnstamped` es seguro.
 */
interface Population {
  readonly recordType: string;
  readonly table: string;
}

const POPULATIONS: readonly Population[] = [
  { recordType: "missing_report", table: "missing_persons" },
  { recordType: "hospital_patient", table: "hospital_patients" },
  { recordType: "unidentified_person", table: "unidentified_persons" },
];

/**
 * Ids de `recordType` SIN PRN (LEFT JOIN contra `person_records`), en orden
 * de `id`, después de `cursor` — keyset, nunca "offset" (que repite o salta
 * filas si la tabla cambia entre páginas). Mismo idioma de paginación
 * acotada que `services/geocode-batch.ts`.
 *
 * `recordType` desconocido -> `[]` (no lanza; deja que el llamador decida qué
 * hacer con una población que no existe).
 */
export async function listUnstamped(
  recordType: string,
  cursor: string | null,
  limit: number,
  scope: TenantScope = colombiaTenantScope(),
): Promise<string[]> {
  const population = POPULATIONS.find((p) => p.recordType === recordType);
  if (!population) return [];

  const db = getDb();
  // Nombre de tabla interpolado con sql.raw: seguro porque `population.table`
  // sale del catálogo cerrado de arriba, jamás de una request.
  const table = sql.raw(`"${population.table}"`);
  const cursorClause = cursor ? sql`AND t.id > ${cursor}` : sql``;
  const tenantPredicate = sqlOwnsIncidentOrLegacyNull(scope, "t");

  const rows = execRows<{ id: string }>(
    await db.execute(sql`
      SELECT t.id
      FROM ${table} t
      LEFT JOIN person_records pr
        ON pr.record_type = ${recordType} AND pr.record_id = t.id
      WHERE pr.prn IS NULL AND ${tenantPredicate} ${cursorClause}
      ORDER BY t.id
      LIMIT ${limit}
    `),
  );
  return rows.map((row) => row.id);
}

/**
 * Encola un mensaje `{ prn }` por PRN en `terremotocolombia-matcher` (U8),
 * vía el binding registrado en `lib/job-dispatch.ts` (`MATCHER_QUEUE`) —
 * mismo seam que el resto de productores del repo, pero consultado
 * DIRECTAMENTE (`getQueueProducer`) en vez de por `dispatchJob`: esta cola no
 * tiene camino BullMQ de respaldo (U8 nace ya en el mundo Cloudflare Queues)
 * y necesita envío en LOTE (`sendBatch`), que `dispatchJob` no expone.
 *
 * SIEMPRE registra la llamada primero (para el test seam `takeMatcherSweepCalls`,
 * más abajo) y solo DESPUÉS intenta el envío real — así en test/dev sin
 * binding de Queues registrado, el comportamiento es record-only (no lanza,
 * no bloquea). `reconcilePersonRecords` la llama con el RETURNING set exacto
 * de cada lote (los PRNs recién estampados EN ESA corrida, nunca los que otro
 * writer ganó por la carrera del ON CONFLICT).
 *
 * Fire-and-forget A PROPÓSITO: la firma es `void` (best-effort, mismo
 * espíritu que `ensurePrn`) y el único call site (`reconcilePersonRecords`)
 * no la espera. Un fallo de envío se loguea pero nunca tumba la corrida del
 * cron — el PRN ya quedó estampado en `person_records`; si el mensaje se
 * pierde, la red de seguridad es la PRÓXIMA corrida del cron encontrando ese
 * mismo registro... salvo que ya esté estampado (no vuelve a aparecer en
 * `listUnstamped`). Ese residual (envío perdido de un PRN ya estampado) es un
 * gap conocido de esta primera versión: no hay cola de reintento de sweeps
 * per se, solo la de Cloudflare Queues para el envío mismo. Ver reporte U8.
 */
let matcherSweepCalls: string[][] = [];

/** Tope de mensajes por `sendBatch` — límite duro de Cloudflare Queues. */
const MATCHER_QUEUE_BATCH_LIMIT = 100;
const MATCHER_QUEUE_BINDING = "MATCHER_QUEUE";

export async function enqueueMatcherSweep(
  prns: string[],
  scope: TenantScope = colombiaTenantScope(),
): Promise<void> {
  matcherSweepCalls.push(prns);
  if (prns.length === 0) return;

  const producer = getQueueProducer(MATCHER_QUEUE_BINDING);
  if (!producer) return; // sin binding registrado (tests, entorno sin U8 desplegado): solo queda el registro de arriba.

  // AWAITED a propósito (bug real de staging, 2026-08-11): con `void ...` el
  // send quedaba como promesa huérfana y Workers la MATA al terminar la
  // respuesta HTTP — el mensaje jamás llegaba a la cola y el matcher no se
  // disparaba en creación, sin un solo error en los logs. Sigue sin lanzar:
  // el fallo se loguea y el sweep perdido lo recoge el siguiente trigger.
  try {
    await sendMatcherSweepMessages(producer, prns, scope);
  } catch (err) {
    console.error(
      `[person-records] enqueueMatcherSweep: fallo enviando ${prns.length} PRN(s) a ${MATCHER_QUEUE_BINDING}:`,
      err,
    );
  }
}

/** Envía en lotes de ≤100 mensajes (`sendBatch` si el binding lo trae —
 *  siempre en un binding real de Queues; `send()` uno por uno como respaldo
 *  para un producer fake de test que solo implemente `send`). */
async function sendMatcherSweepMessages(
  producer: QueueProducer,
  prns: string[],
  scope: TenantScope,
): Promise<void> {
  const tenant = tenantJobFields(scope);
  for (let i = 0; i < prns.length; i += MATCHER_QUEUE_BATCH_LIMIT) {
    const chunk = prns.slice(i, i + MATCHER_QUEUE_BATCH_LIMIT);
    if (producer.sendBatch) {
      await producer.sendBatch(chunk.map((prn) => ({ body: { prn, ...tenant } })));
    } else {
      await Promise.all(chunk.map((prn) => producer.send({ prn, ...tenant })));
    }
  }
}

/**
 * SOLO para tests: drena y devuelve las llamadas acumuladas a
 * `enqueueMatcherSweep`, en orden. Existe porque una llamada intra-módulo
 * (como la de `reconcilePersonRecords` de aquí abajo) no pasa por el binding
 * exportado, así que un `vi.spyOn` sobre este módulo no la vería — mismo
 * idioma que `resetJobBindings` en `lib/job-dispatch.ts`.
 */
export function takeMatcherSweepCalls(): string[][] {
  const calls = matcherSweepCalls;
  matcherSweepCalls = [];
  return calls;
}

/**
 * KTD8 (U9): tres invariantes de cluster + un barrido de PII, enganchados
 * desde `services/person-links.ts` — import DINÁMICO a propósito, no
 * estático: person-links.ts importa `enqueueMatcherSweep`/`resolvePrn` de
 * ESTE archivo a nivel de módulo, así que un `import` estático aquí, en la
 * dirección contraria, sería un ciclo real (person-records ⇄ person-links)
 * en el momento de evaluación del módulo. El `await import()` diferido evita
 * el ciclo por completo — mismo idioma que ya usa `worker.ts` para cargar
 * handlers bajo demanda.
 *
 * Cadencia: (a) coincidencia de extremos de link confirmado y (c) estado sin
 * decisión son BARATAS (recorren `person_links`, no caminan clusters) y
 * corren en CADA llamada. (b) la caminata de conectividad por cluster —y el
 * barrido `scanNotesForPii`, que no es barato tampoco (dos scans con regex
 * sobre texto libre)— corren en una cadencia MÁS LENTA (1 de cada
 * `CLUSTER_INVARIANT_SLOW_CADENCE` corridas), con su propio presupuesto de
 * tiempo. El contador es in-memory por-isolate — "mejor esfuerzo", no una
 * garantía dura de cadencia (un isolate reciclado la reinicia) — mismo
 * espíritu que el resto de este archivo (ensurePrn, enqueueMatcherSweep).
 *
 * Errores: se atrapan y loguean AQUÍ (no se propagan a `reconcilePersonRecords`,
 * que sí decide propagar los SUYOS a propósito — ver su docstring). Esta
 * corrida es reparación de mejor esfuerzo sobre trabajo YA completado (el
 * backfill de PRNs de esta misma invocación ya terminó cuando se llega
 * aquí); que un invariante falle no debería re-encolar todo el backfill vía
 * el reintento de cron de Cloudflare. La red de seguridad real es que la
 * PRÓXIMA corrida del cron lo vuelve a intentar (los reparos son
 * idempotentes).
 */
let clusterInvariantRunCount = 0;
const CLUSTER_INVARIANT_SLOW_CADENCE = 10;
const CLUSTER_INVARIANT_CONNECTIVITY_BUDGET_MS = 5_000;

export async function runClusterInvariantChecks(): Promise<void> {
  try {
    const { repairConfirmedLinkEndpoints, repairUndecidedStatuses, repairClusterConnectivity, scanNotesForPii } =
      await import("@/services/person-links");

    await repairConfirmedLinkEndpoints();
    await repairUndecidedStatuses();

    clusterInvariantRunCount++;
    const runSlowChecks = clusterInvariantRunCount % CLUSTER_INVARIANT_SLOW_CADENCE === 1;
    if (runSlowChecks) {
      await repairClusterConnectivity({ timeBudgetMs: CLUSTER_INVARIANT_CONNECTIVITY_BUDGET_MS });
      // Solo detecta — nunca repara sola (una nota/metadata con PII es una
      // decisión de revisión humana, no algo que este cron pueda "arreglar").
      // Se loguean ÚNICAMENTE ids/conteos (el propio scan nunca trae el texto
      // ofensor a memoria de la app — ver su docstring en person-links.ts).
      const pii = await scanNotesForPii();
      if (pii.decisionOffenderIds.length > 0 || pii.auditOffenderIds.length > 0) {
        console.error(
          `[person-records] scanNotesForPii: posible PII en texto libre — ` +
            `${pii.decisionOffenderIds.length} person_link_decisions.note (ids: ${pii.decisionOffenderIds.join(", ")}), ` +
            `${pii.auditOffenderIds.length} audit_log.metadata (ids: ${pii.auditOffenderIds.join(", ")}). Revisión humana requerida.`,
        );
      }
    }
  } catch (err) {
    console.error("[person-records] runClusterInvariantChecks falló (mejor esfuerzo, se reintenta en la próxima corrida):", err);
  }
}

/** Resultado de una corrida de `reconcilePersonRecords`. */
export interface ReconcileResult {
  /** PRNs nuevos estampados en esta corrida, por `record_type`. */
  stampedByType: Record<string, number>;
  /** Total de PRNs nuevos estampados en esta corrida (todas las poblaciones). */
  stampedTotal: number;
  /** true si esa población quedó sin backlog al terminar esta corrida (no
   *  implica que el backlog GLOBAL esté vacío — solo que esta corrida no dejó
   *  nada pendiente detrás del cursor con el que empezó). */
  drainedByType: Record<string, boolean>;
}

const DEFAULT_RECONCILE_BATCH_SIZE = 200;
const DEFAULT_RECONCILE_TIME_BUDGET_MS = 60_000;

/**
 * El cron de reconciliación (KTD8): para cada población, pagina por
 * `listUnstamped` detrás de un cursor de `id`, estampa cada lote con
 * `stampBatch` (misma disciplina que `ensurePrn`), y encola un matcher sweep
 * SOLO con lo que esta corrida insertó de verdad. Acotado por cantidad
 * (`batchSize`) y por tiempo (`timeBudgetMs`) — patrón calcado de
 * `services/geocode-batch.ts`: sus primeras corridas SON el backfill de lo
 * que ya existía; en régimen permanente es la red de seguridad de la carrera
 * del camino inline.
 *
 * Sin catch propio a propósito: un fallo se propaga (como `runGeocode`), para
 * que quien la invoque desde el handler `scheduled` decida logueo y
 * reintento — Cloudflare reintenta un cron cuyo handler lanza, y eso es lo
 * deseable aquí (la escritura es idempotente).
 */
export async function reconcilePersonRecords(
  opts: { timeBudgetMs?: number; batchSize?: number; scope?: TenantScope } = {},
): Promise<ReconcileResult> {
  const timeBudgetMs = Math.max(
    1,
    Math.trunc(opts.timeBudgetMs ?? DEFAULT_RECONCILE_TIME_BUDGET_MS),
  );
  const batchSize = Math.min(
    Math.max(Math.trunc(opts.batchSize ?? DEFAULT_RECONCILE_BATCH_SIZE), 1),
    1000,
  );
  const startedAt = Date.now();
  const scope = opts.scope ?? colombiaTenantScope();

  const result: ReconcileResult = { stampedByType: {}, stampedTotal: 0, drainedByType: {} };

  for (const population of POPULATIONS) {
    result.stampedByType[population.recordType] = 0;
    result.drainedByType[population.recordType] = false;
    let cursor: string | null = null;

    while (Date.now() - startedAt < timeBudgetMs) {
      const ids = await listUnstamped(population.recordType, cursor, batchSize, scope);
      if (ids.length === 0) {
        result.drainedByType[population.recordType] = true;
        break;
      }

      const stamped = await stampBatch(population.recordType, ids, startedAt, scope);
      result.stampedByType[population.recordType] =
        (result.stampedByType[population.recordType] ?? 0) + stamped.length;
      result.stampedTotal += stamped.length;
      if (stamped.length > 0) {
        await enqueueMatcherSweep(stamped.map((row) => row.prn), scope);
      }

      // Avanza sobre TODO el lote leído, no solo sobre lo insertado por esta
      // corrida: una fila que otro writer ya estampó (ON CONFLICT DO NOTHING
      // la deja fuera de `stamped`) sigue estando estampada — releerla en la
      // próxima página sería trabajo perdido, no progreso.
      cursor = ids[ids.length - 1] ?? cursor;

      if (ids.length < batchSize) {
        result.drainedByType[population.recordType] = true;
        break;
      }
    }
  }

  await runClusterInvariantChecks();

  return result;
}
