/**
 * U9 — motor de clusters (`services/person-clusters.ts`): `recomputeClusterFor`
 * (los 5 sub-pasos del algoritmo — R13), derivación de status (R13), y
 * `isAnchoredMerge` (R18).
 *
 * NO SE PUEDE CORRER en este entorno (sin node_modules) — se escribe ANTES de
 * verificar la implementación con `tsc`/`vitest run`, siguiendo el mismo
 * idioma de fixtures que `test/matcher.test.ts` (tokens aleatorios por
 * nombre, para que ningún test cruce con otro en la DB compartida).
 *
 * Requiere el stack local arriba (docker compose up): DATABASE_URL. PII
 * sintética: nombres DEMO con token aleatorio, nunca datos reales.
 */
import { randomUUID } from "crypto";
import { and, eq, isNull } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { testTenantOwnership } from "./helpers";

let db: typeof import("@/db");
let personRecords: typeof import("@/services/person-records");
let clusters: typeof import("@/services/person-clusters");
let matcherPropose: typeof import("@/services/matcher/propose");

beforeAll(async () => {
  db = await import("@/db");
  personRecords = await import("@/services/person-records");
  clusters = await import("@/services/person-clusters");
  matcherPropose = await import("@/services/matcher/propose");
});

// --------------------------------------------------------------- seeding ---

function token(): string {
  return randomUUID().slice(0, 8);
}

async function makeHospital(): Promise<string> {
  const id = randomUUID();
  await db.getDb().insert(db.schema.hospitals).values({
    id,
    name: `DEMO Hospital Clusters ${id.slice(0, 8)}`,
    createdAt: Date.now(),
      ...testTenantOwnership(),
    });
  return id;
}

async function seedMissing(name: string, age: number | null = null): Promise<string> {
  const id = randomUUID();
  await db.getDb().insert(db.schema.missingPersons).values({
    id,
    name,
    age,
    createdAt: Date.now(),
      ...testTenantOwnership(),
    });
  return id;
}

async function seedPatient(hospitalId: string, name: string): Promise<string> {
  const id = randomUUID();
  const now = Date.now();
  await db.getDb().insert(db.schema.hospitalPatients).values({
    id,
    hospitalId,
    name,
    admittedAt: now,
    updatedAt: now,
      ...testTenantOwnership(),
    });
  return id;
}

async function prnFor(recordType: string, recordId: string): Promise<string> {
  const prn = await personRecords.ensurePrn(recordType, recordId);
  if (!prn) throw new Error(`no se pudo estampar PRN de prueba (${recordType}/${recordId})`);
  return prn;
}

/** Siembra una fila `person_links` CONFIRMADA directamente (bypassa el
 *  protocolo de decisión de person-links.ts — este archivo prueba el motor de
 *  clusters, no la ruta de decisión). */
async function seedConfirmedLink(prnX: string, prnY: string): Promise<string> {
  const [prnA, prnB] = matcherPropose.orderPair(prnX, prnY);
  const id = randomUUID();
  await db
    .getDb()
    .insert(db.schema.personLinks)
    .values({
      id,
      prnA,
      prnB,
      status: "confirmed",
      score: 1,
      evidence: {},
      evidenceClass: "manual",
      method: "manual",
      matcherVersion: null,
      proposedAt: Date.now(),
      ...testTenantOwnership(),
    })
    .onConflictDoNothing();
  return id;
}

async function setLinkStatus(linkId: string, status: string): Promise<void> {
  await db.getDb().update(db.schema.personLinks).set({ status }).where(eq(db.schema.personLinks.id, linkId));
}

async function liveMembershipRowsFor(prn: string) {
  return db
    .getDb()
    .select()
    .from(db.schema.personClusterMembers)
    .where(and(eq(db.schema.personClusterMembers.prn, prn), isNull(db.schema.personClusterMembers.removedAt)));
}

// ------------------------------------------------------------------ tests ---

describe("recomputeClusterFor — sin links confirmados", () => {
  it("un PRN aislado converge a un cluster propio de 1 miembro vivo; correr dos veces es no-op", async () => {
    const t = token();
    const id = await seedMissing(`DEMO Cluster Singleton ${t}`);
    const prn = await prnFor("missing_report", id);

    const first = await clusters.recomputeClusterFor(prn);
    expect(first.status).toBe("reported_missing");
    expect(await clusters.liveMembersOf(first.clusterId)).toEqual([prn]);

    const second = await clusters.recomputeClusterFor(prn);
    expect(second.clusterId).toBe(first.clusterId);
    expect(second.status).toBe(first.status);
    expect(await clusters.liveMembersOf(second.clusterId)).toEqual([prn]);

    const rows = await liveMembershipRowsFor(prn);
    expect(rows).toHaveLength(1); // sin duplicados
  });
});

describe("recomputeClusterFor — A-B confirmado, luego B-C confirmado", () => {
  it("termina en UN cluster con tres miembros vivos, sin membresías duplicadas", async () => {
    const t = token();
    const idA = await seedMissing(`DEMO Chain A ${t}`);
    const idB = await seedMissing(`DEMO Chain B ${t}`);
    const idC = await seedMissing(`DEMO Chain C ${t}`);
    const prnA = await prnFor("missing_report", idA);
    const prnB = await prnFor("missing_report", idB);
    const prnC = await prnFor("missing_report", idC);

    await seedConfirmedLink(prnA, prnB);
    const afterAB = await clusters.recomputeClusterFor(prnA);
    expect(await clusters.liveMembersOf(afterAB.clusterId)).toHaveLength(2);

    await seedConfirmedLink(prnB, prnC);
    const afterBC = await clusters.recomputeClusterFor(prnB);

    const members = await clusters.liveMembersOf(afterBC.clusterId);
    expect(new Set(members)).toEqual(new Set([prnA, prnB, prnC]));
    expect(members).toHaveLength(3);

    for (const prn of [prnA, prnB, prnC]) {
      expect(await liveMembershipRowsFor(prn)).toHaveLength(1);
    }
  });
});

describe("recomputeClusterFor — merge luego unmerge (sub-paso 5: evict beyond the seed)", () => {
  it("fusiona {A,B}+{C,D} vía B-C; al deshacer B-C, C y D terminan en su PROPIO cluster (no varados en el fusionado)", async () => {
    const t = token();
    const [idA, idB, idC, idD] = await Promise.all([
      seedMissing(`DEMO Evict A ${t}`),
      seedMissing(`DEMO Evict B ${t}`),
      seedMissing(`DEMO Evict C ${t}`),
      seedMissing(`DEMO Evict D ${t}`),
    ]);
    const [prnA, prnB, prnC, prnD] = await Promise.all([
      prnFor("missing_report", idA),
      prnFor("missing_report", idB),
      prnFor("missing_report", idC),
      prnFor("missing_report", idD),
    ]);

    await seedConfirmedLink(prnA, prnB);
    const clusterAB = (await clusters.recomputeClusterFor(prnA)).clusterId;

    await seedConfirmedLink(prnC, prnD);
    const clusterCD = (await clusters.recomputeClusterFor(prnC)).clusterId;
    expect(clusterCD).not.toBe(clusterAB);

    const bcLinkId = await seedConfirmedLink(prnB, prnC);
    const merged = await clusters.recomputeClusterFor(prnB);
    // Canónico = el cluster MÁS ANTIGUO de los dos que se fusionan: clusterAB
    // se creó primero.
    expect(merged.clusterId).toBe(clusterAB);
    expect(new Set(await clusters.liveMembersOf(clusterAB))).toEqual(
      new Set([prnA, prnB, prnC, prnD]),
    );
    expect(await clusters.liveMembersOf(clusterCD)).toEqual([]); // drenado

    // Deshacer B-C (lo que unmergeLink hace al link): status -> rejected.
    await setLinkStatus(bcLinkId, "rejected");
    const afterUnmerge = await clusters.recomputeClusterFor(prnB);

    expect(afterUnmerge.clusterId).toBe(clusterAB);
    expect(new Set(await clusters.liveMembersOf(clusterAB))).toEqual(new Set([prnA, prnB]));

    const cLive = await clusters.liveClusterOf(prnC);
    const dLive = await clusters.liveClusterOf(prnD);
    expect(cLive).not.toBeNull();
    expect(cLive).not.toBe(clusterAB);
    expect(dLive).toBe(cLive); // C y D terminan juntos en su cluster propio.

    // Historia preservada: A,B,C,D tienen todos ≥1 fila histórica en el
    // cluster fusionado (removed_at no-null para C/D), nunca DELETE.
    const cRowsInMerged = await db
      .getDb()
      .select()
      .from(db.schema.personClusterMembers)
      .where(and(eq(db.schema.personClusterMembers.prn, prnC), eq(db.schema.personClusterMembers.clusterId, clusterAB)));
    expect(cRowsInMerged.length).toBeGreaterThan(0);
    expect(cRowsInMerged.every((r) => r.removedAt !== null)).toBe(true);
  });
});

describe("recomputeClusterFor — idempotencia y concurrencia", () => {
  it("correr dos veces SEGUIDAS produce un conjunto de membresía byte-idéntico", async () => {
    const t = token();
    const idA = await seedMissing(`DEMO Idem A ${t}`);
    const idB = await seedMissing(`DEMO Idem B ${t}`);
    const prnA = await prnFor("missing_report", idA);
    const prnB = await prnFor("missing_report", idB);
    await seedConfirmedLink(prnA, prnB);

    const first = await clusters.recomputeClusterFor(prnA);
    const membersFirst = [...(await clusters.liveMembersOf(first.clusterId))].sort();

    const second = await clusters.recomputeClusterFor(prnA);
    const membersSecond = [...(await clusters.liveMembersOf(second.clusterId))].sort();

    expect(second.clusterId).toBe(first.clusterId);
    expect(membersSecond).toEqual(membersFirst);
  });

  it("correr recomputeClusterFor DOS VECES EN PARALELO sobre un componente fresco converge a UN solo cluster vivo, sin lanzar", async () => {
    const t = token();
    const idA = await seedMissing(`DEMO Concurrent A ${t}`);
    const idB = await seedMissing(`DEMO Concurrent B ${t}`);
    const prnA = await prnFor("missing_report", idA);
    const prnB = await prnFor("missing_report", idB);
    await seedConfirmedLink(prnA, prnB);

    const [r1, r2] = await Promise.all([
      clusters.recomputeClusterFor(prnA),
      clusters.recomputeClusterFor(prnA),
    ]);

    expect(r1.clusterId).toBe(r2.clusterId);
    const clusterA = await clusters.liveClusterOf(prnA);
    const clusterB = await clusters.liveClusterOf(prnB);
    expect(clusterA).not.toBeNull();
    expect(clusterA).toBe(clusterB);
    expect(clusterA).toBe(r1.clusterId);

    // exactamente una fila VIVA por PRN (el índice parcial es el árbitro).
    expect(await liveMembershipRowsFor(prnA)).toHaveLength(1);
    expect(await liveMembershipRowsFor(prnB)).toHaveLength(1);
  });
});

describe("recomputeClusterFor — derivación de status", () => {
  it("un cluster con un miembro hospital_patient lee 'located_hospital'", async () => {
    const t = token();
    const hospitalId = await makeHospital();
    const idMissing = await seedMissing(`DEMO Status Missing ${t}`);
    const idPatient = await seedPatient(hospitalId, `DEMO Status Patient ${t}`);
    const prnMissing = await prnFor("missing_report", idMissing);
    const prnPatient = await prnFor("hospital_patient", idPatient);

    await seedConfirmedLink(prnMissing, prnPatient);
    const result = await clusters.recomputeClusterFor(prnMissing);

    expect(result.status).toBe("located_hospital");
  });

  it("un cluster sin ningún hospital_patient lee 'reported_missing'", async () => {
    const t = token();
    const idA = await seedMissing(`DEMO Status Only Missing A ${t}`);
    const idB = await seedMissing(`DEMO Status Only Missing B ${t}`);
    const prnA = await prnFor("missing_report", idA);
    const prnB = await prnFor("missing_report", idB);
    await seedConfirmedLink(prnA, prnB);

    const result = await clusters.recomputeClusterFor(prnA);
    expect(result.status).toBe("reported_missing");
  });
});

describe("isAnchoredMerge (R18)", () => {
  it("dos singletons (sin cluster, sin otros links confirmados) NO son una fusión anclada", async () => {
    const t = token();
    const idA = await seedMissing(`DEMO Anchor Singleton A ${t}`);
    const idB = await seedMissing(`DEMO Anchor Singleton B ${t}`);
    const prnA = await prnFor("missing_report", idA);
    const prnB = await prnFor("missing_report", idB);
    const linkId = await seedConfirmedLink(prnA, prnB); // aún no recomputado

    const anchored = await clusters.isAnchoredMerge(prnA, prnB, linkId);
    expect(anchored).toBe(false);
  });

  it("dos clusters de 2 miembros cada uno SÍ son una fusión anclada al confirmarse un puente entre ellos", async () => {
    const t = token();
    const [idA, idB, idC, idD] = await Promise.all([
      seedMissing(`DEMO Anchor A ${t}`),
      seedMissing(`DEMO Anchor B ${t}`),
      seedMissing(`DEMO Anchor C ${t}`),
      seedMissing(`DEMO Anchor D ${t}`),
    ]);
    const [prnA, prnB, prnC, prnD] = await Promise.all([
      prnFor("missing_report", idA),
      prnFor("missing_report", idB),
      prnFor("missing_report", idC),
      prnFor("missing_report", idD),
    ]);

    await seedConfirmedLink(prnA, prnB);
    await clusters.recomputeClusterFor(prnA);
    await seedConfirmedLink(prnC, prnD);
    await clusters.recomputeClusterFor(prnC);

    const bridgeLinkId = await seedConfirmedLink(prnB, prnC);
    const anchored = await clusters.isAnchoredMerge(prnB, prnC, bridgeLinkId);
    expect(anchored).toBe(true);
  });

  it("si ambos lados YA están en el MISMO cluster, no cuenta como fusión anclada (no es una fusión nueva)", async () => {
    const t = token();
    const idA = await seedMissing(`DEMO Anchor Same A ${t}`);
    const idB = await seedMissing(`DEMO Anchor Same B ${t}`);
    const idC = await seedMissing(`DEMO Anchor Same C ${t}`);
    const prnA = await prnFor("missing_report", idA);
    const prnB = await prnFor("missing_report", idB);
    const prnC = await prnFor("missing_report", idC);

    await seedConfirmedLink(prnA, prnB);
    await seedConfirmedLink(prnB, prnC);
    await clusters.recomputeClusterFor(prnA); // A,B,C ya en el mismo cluster

    // Un link A-C adicional (redundante, mismo cluster de los dos lados).
    const redundantLinkId = await seedConfirmedLink(prnA, prnC);
    const anchored = await clusters.isAnchoredMerge(prnA, prnC, redundantLinkId);
    expect(anchored).toBe(false);
  });
});
