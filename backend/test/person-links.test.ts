/**
 * U9 — decisiones sobre `person_links` (R12/R14/R15/R16/R18/R20): protocolo
 * de claim/conflict del endpoint de decisión, propuesta manual, unmerge,
 * escalación de fusión anclada (TOCTOU), reparo de invariantes y
 * `scanNotesForPii`. Complementa `test/person-clusters.test.ts` (motor de
 * clusters puro).
 *
 * NO SE PUEDE CORRER en este entorno (sin node_modules) — escrito ANTES de
 * verificar con `tsc`/`vitest run`. Mismos idiomas de fixtures que
 * `test/matcher.test.ts` / `test/patient-import-rows.test.ts` /
 * `test/authz-matrix.test.ts`: helpers duplicados a propósito (convención ya
 * establecida en este repo), tokens aleatorios por nombre para que ningún
 * test cruce con otro en la DB compartida, `Promise.allSettled` para probar
 * la carrera de claim.
 *
 * Requiere el stack local arriba (docker compose up): DATABASE_URL +
 * VALKEY_URL. PII sintética: nombres DEMO con token aleatorio, cédulas de
 * prueba, nunca datos reales.
 */
import { randomUUID } from "crypto";
import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import "./helpers";
import request from "supertest";
import { makeUserWithCaps, testTenantOwnership} from "./helpers";

let app: import("express").Express;
let db: typeof import("@/db");
let personRecords: typeof import("@/services/person-records");
let personLinksService: typeof import("@/services/person-links");
let clusters: typeof import("@/services/person-clusters");
let matcherPropose: typeof import("@/services/matcher/propose");
let matcher: typeof import("@/services/matcher");

beforeAll(async () => {
  app = (await import("@/server")).app;
  db = await import("@/db");
  personRecords = await import("@/services/person-records");
  personLinksService = await import("@/services/person-links");
  clusters = await import("@/services/person-clusters");
  matcherPropose = await import("@/services/matcher/propose");
  matcher = await import("@/services/matcher");
});

// --------------------------------------------------------------- seeding ---

function token(): string {
  return randomUUID().slice(0, 8);
}

async function seedMissing(opts: { name: string; age?: number | null; documentHash?: string | null }): Promise<string> {
  const id = randomUUID();
  await db.getDb().insert(db.schema.missingPersons).values({
    id,
    name: opts.name,
    age: opts.age ?? null,
    documentHash: opts.documentHash ?? null,
    createdAt: Date.now(),
      ...testTenantOwnership(),
    });
  return id;
}

async function prnFor(recordType: string, recordId: string): Promise<string> {
  const prn = await personRecords.ensurePrn(recordType, recordId);
  if (!prn) throw new Error(`no se pudo estampar PRN de prueba (${recordType}/${recordId})`);
  return prn;
}

/** Siembra una fila `person_links` 'proposed' directamente (bypassa el
 *  matcher y el endpoint /propose — sirve para arrancar un escenario de
 *  decisión desde un estado conocido). */
async function seedProposedLink(prnX: string, prnY: string, evidenceClass = "manual"): Promise<string> {
  const [prnA, prnB] = matcherPropose.orderPair(prnX, prnY);
  const id = randomUUID();
  await db
    .getDb()
    .insert(db.schema.personLinks)
    .values({
      id,
      prnA,
      prnB,
      status: "proposed",
      score: 0.5,
      evidence: {},
      evidenceClass,
      method: "manual",
      matcherVersion: null,
      proposedAt: Date.now(),
      ...testTenantOwnership(),
    })
    .onConflictDoNothing();
  return id;
}

/** Siembra una fila `person_links` 'confirmed' DIRECTAMENTE — bypassa
 *  `decideLink` (que además recomputaría el cluster correctamente). Sirve
 *  para fabricar el estado ROTO que los reparos de invariante (a)/(b) deben
 *  corregir: un link confirmado cuyos extremos NO están (todavía) en el
 *  mismo cluster vivo, sin pasar por el camino que los mantendría
 *  consistentes. */
async function seedConfirmedLinkDirect(prnX: string, prnY: string, evidenceClass = "manual"): Promise<string> {
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
      score: 0.9,
      evidence: {},
      evidenceClass,
      method: "manual",
      matcherVersion: null,
      proposedAt: Date.now(),
      ...testTenantOwnership(),
    })
    .onConflictDoNothing();
  return id;
}

/** Siembra un `person_clusters` vacío DIRECTAMENTE. */
async function seedCluster(): Promise<string> {
  const id = randomUUID();
  await db.getDb().insert(db.schema.personClusters).values({
    id,
    status: "reported_missing",
    createdAt: Date.now(),
      ...testTenantOwnership(),
    });
  return id;
}

/** Siembra una membresía VIVA (`removed_at` null) de `prn` en `clusterId`
 *  DIRECTAMENTE — bypassa `recomputeClusterFor`, que es el único escritor
 *  real de `person_cluster_members` (ver docstring de person-clusters.ts).
 *  Sirve para fabricar a mano el estado que los reparos de invariante deben
 *  encontrar y corregir. */
async function seedLiveMembership(prn: string, clusterId: string): Promise<void> {
  await db.getDb().insert(db.schema.personClusterMembers).values({
    id: randomUUID(),
    clusterId,
    prn,
    addedAt: Date.now(),
    removedAt: null,
    addedBy: "system",
      ...testTenantOwnership(),
    });
}

async function rawLink(linkId: string): Promise<typeof db.schema.personLinks.$inferSelect | null> {
  const rows = await db.getDb().select().from(db.schema.personLinks).where(eq(db.schema.personLinks.id, linkId));
  return rows[0] ?? null;
}

async function decisionsFor(linkId: string) {
  return db.getDb().select().from(db.schema.personLinkDecisions).where(eq(db.schema.personLinkDecisions.linkId, linkId));
}

async function auditRowsFor(action: string, targetId: string) {
  return db
    .getDb()
    .select()
    .from(db.schema.auditLog)
    .where(and(eq(db.schema.auditLog.action, action), eq(db.schema.auditLog.targetId, targetId)));
}

const BASE = "/api/public/person-links";

// ------------------------------------------------------------------ tests ---

describe("POST /:linkId/decision — confirmar (R12)", () => {
  it("confirmar entre dos singletons → 200, un cluster con dos miembros vivos, fila de decisión con snapshot, fila de auditoría", async () => {
    const { token: authToken, id: actorId } = await makeUserWithCaps(["person:review"]);
    const t = token();
    const idA = await seedMissing({ name: `DEMO Confirm A ${t}` });
    const idB = await seedMissing({ name: `DEMO Confirm B ${t}` });
    const prnA = await prnFor("missing_report", idA);
    const prnB = await prnFor("missing_report", idB);
    const linkId = await seedProposedLink(prnA, prnB);

    const res = await request(app)
      .post(`${BASE}/${linkId}/decision`)
      .set("Authorization", `Bearer ${authToken}`)
      .send({ decision: "confirmar" });

    expect(res.status).toBe(200);
    expect(res.body.item.status).toBe("confirmed");
    expect(res.body.idempotentReplay).toBe(false);

    const decisions = await decisionsFor(linkId);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]!.decision).toBe("confirmed");
    expect(decisions[0]!.decidedBy).toBe(actorId);
    expect(decisions[0]!.evidenceSnapshot).toBeTruthy();

    const clusterA = await clusters.liveClusterOf(prnA);
    const clusterB = await clusters.liveClusterOf(prnB);
    expect(clusterA).not.toBeNull();
    expect(clusterA).toBe(clusterB);
    expect(await clusters.liveMembersOf(clusterA!)).toHaveLength(2);

    const audits = await auditRowsFor("personlink.confirm", linkId);
    expect(audits).toHaveLength(1);
    expect(audits[0]!.actorUserId).toBe(actorId);
  });

  it("404 sobre un linkId inexistente", async () => {
    const { token: authToken } = await makeUserWithCaps(["person:review"]);
    const res = await request(app)
      .post(`${BASE}/${randomUUID()}/decision`)
      .set("Authorization", `Bearer ${authToken}`)
      .send({ decision: "confirmar" });
    expect(res.status).toBe(404);
  });
});

describe("POST /:linkId/decision — concurrencia (R20)", () => {
  it("dos revisores deciden el MISMO vínculo concurrentemente → exactamente una fila de decisión; el perdedor recibe 409", async () => {
    const [{ token: tokenA }, { token: tokenB }] = await Promise.all([
      makeUserWithCaps(["person:review"]),
      makeUserWithCaps(["person:review"]),
    ]);
    const t = token();
    const idA = await seedMissing({ name: `DEMO Race A ${t}` });
    const idB = await seedMissing({ name: `DEMO Race B ${t}` });
    const prnA = await prnFor("missing_report", idA);
    const prnB = await prnFor("missing_report", idB);
    const linkId = await seedProposedLink(prnA, prnB);

    const [r1, r2] = await Promise.allSettled([
      request(app).post(`${BASE}/${linkId}/decision`).set("Authorization", `Bearer ${tokenA}`).send({ decision: "confirmar" }),
      request(app).post(`${BASE}/${linkId}/decision`).set("Authorization", `Bearer ${tokenB}`).send({ decision: "confirmar" }),
    ]);

    const statuses = [r1, r2].map((r) => (r.status === "fulfilled" ? r.value.status : -1));
    expect(statuses.filter((s) => s === 200)).toHaveLength(1);
    expect(statuses.filter((s) => s === 409)).toHaveLength(1);

    expect(await decisionsFor(linkId)).toHaveLength(1);
  });

  it("mismo revisor repite la misma decisión → 200 idempotente (sigue habiendo UNA fila de decisión); otro revisor → 409", async () => {
    const { token: tokenA } = await makeUserWithCaps(["person:review"]);
    const { token: tokenB } = await makeUserWithCaps(["person:review"]);
    const t = token();
    const idA = await seedMissing({ name: `DEMO Replay A ${t}` });
    const idB = await seedMissing({ name: `DEMO Replay B ${t}` });
    const prnA = await prnFor("missing_report", idA);
    const prnB = await prnFor("missing_report", idB);
    const linkId = await seedProposedLink(prnA, prnB);

    const first = await request(app).post(`${BASE}/${linkId}/decision`).set("Authorization", `Bearer ${tokenA}`).send({ decision: "confirmar" });
    expect(first.status).toBe(200);

    const replay = await request(app).post(`${BASE}/${linkId}/decision`).set("Authorization", `Bearer ${tokenA}`).send({ decision: "confirmar" });
    expect(replay.status).toBe(200);
    expect(replay.body.idempotentReplay).toBe(true);
    expect(await decisionsFor(linkId)).toHaveLength(1);

    const other = await request(app).post(`${BASE}/${linkId}/decision`).set("Authorization", `Bearer ${tokenB}`).send({ decision: "confirmar" });
    expect(other.status).toBe(409);
  });
});

describe("POST /:linkId/decision — inseguro", () => {
  it("sin nota → 400; con nota → status unsure, aparece en la cola filtrada por status=unsure", async () => {
    const { token: authToken } = await makeUserWithCaps(["person:review", "person:search"]);
    const t = token();
    const idA = await seedMissing({ name: `DEMO Unsure A ${t}` });
    const idB = await seedMissing({ name: `DEMO Unsure B ${t}` });
    const prnA = await prnFor("missing_report", idA);
    const prnB = await prnFor("missing_report", idB);
    const linkId = await seedProposedLink(prnA, prnB);

    const noNote = await request(app).post(`${BASE}/${linkId}/decision`).set("Authorization", `Bearer ${authToken}`).send({ decision: "inseguro" });
    expect(noNote.status).toBe(400);

    const withNote = await request(app)
      .post(`${BASE}/${linkId}/decision`)
      .set("Authorization", `Bearer ${authToken}`)
      .send({ decision: "inseguro", note: "Necesita más evidencia." });
    expect(withNote.status).toBe(200);
    expect(withNote.body.item.status).toBe("unsure");

    const queueRes = await request(app).get(`${BASE}/queue?status=unsure`).set("Authorization", `Bearer ${authToken}`);
    expect(queueRes.status).toBe(200);
    expect(
      (queueRes.body.items as { link: { id: string } }[]).some((i) => i.link.id === linkId),
    ).toBe(true);
  });
});

describe("POST /:linkId/decision — rechazar (R14: tombstone)", () => {
  it("rechazar → re-correr el matcher para el mismo par NO produce una nueva propuesta", async () => {
    const { token: authToken } = await makeUserWithCaps(["person:review"]);
    const t = token();
    const name = `DEMO Tombstone ${t}`;
    const idA = await seedMissing({ name, age: 40 });
    const idB = await seedMissing({ name, age: 40 });
    const prnA = await prnFor("missing_report", idA);
    const prnB = await prnFor("missing_report", idB);

    await matcher.processMatcherMessage({ prn: prnA }); // matcher REAL: name_age_exact
    const [pa, pb] = matcherPropose.orderPair(prnA, prnB);
    const before = await db
      .getDb()
      .select()
      .from(db.schema.personLinks)
      .where(and(eq(db.schema.personLinks.prnA, pa), eq(db.schema.personLinks.prnB, pb)));
    expect(before).toHaveLength(1);
    const linkId = before[0]!.id;

    const res = await request(app).post(`${BASE}/${linkId}/decision`).set("Authorization", `Bearer ${authToken}`).send({ decision: "rechazar" });
    expect(res.status).toBe(200);
    expect(res.body.item.status).toBe("rejected");

    await matcher.processMatcherMessage({ prn: prnA }); // re-sweep: misma clase, no reabre.
    const after = await rawLink(linkId);
    expect(after!.status).toBe("rejected");
  });
});

describe("POST /:linkId/unmerge (R15)", () => {
  it("deshace un cluster de 2: membresías con removed_at (preservadas), decisión 'rescinded' agregada, matcher re-encolado para ambos, el par NO se re-propone con la misma clase", async () => {
    const { token: reviewToken } = await makeUserWithCaps(["person:review"]);
    const { token: mergeToken } = await makeUserWithCaps(["person:merge"]);
    const t = token();
    const name = `DEMO Unmerge ${t}`;
    const idA = await seedMissing({ name, age: 33 });
    const idB = await seedMissing({ name, age: 33 });
    const prnA = await prnFor("missing_report", idA);
    const prnB = await prnFor("missing_report", idB);

    await matcher.processMatcherMessage({ prn: prnA });
    const [pa, pb] = matcherPropose.orderPair(prnA, prnB);
    const linkRows = await db
      .getDb()
      .select()
      .from(db.schema.personLinks)
      .where(and(eq(db.schema.personLinks.prnA, pa), eq(db.schema.personLinks.prnB, pb)));
    const linkId = linkRows[0]!.id;

    const confirmRes = await request(app).post(`${BASE}/${linkId}/decision`).set("Authorization", `Bearer ${reviewToken}`).send({ decision: "confirmar" });
    expect(confirmRes.status).toBe(200);

    const clusterId = (await clusters.liveClusterOf(prnA))!;
    expect(await clusters.liveMembersOf(clusterId)).toHaveLength(2);

    personRecords.takeMatcherSweepCalls(); // drena lo acumulado hasta aquí

    const unmergeRes = await request(app)
      .post(`${BASE}/${linkId}/unmerge`)
      .set("Authorization", `Bearer ${mergeToken}`)
      .send({ note: "Eran dos personas distintas." });
    expect(unmergeRes.status).toBe(200);
    expect(unmergeRes.body.item.status).toBe("rejected");

    const decisions = await decisionsFor(linkId);
    expect(decisions.some((d) => d.decision === "rescinded")).toBe(true);

    // Contrato real (KTD3): el cluster NO se disuelve — el recompute reutiliza
    // el cluster más antiguo para uno de los separados (queda como singleton)
    // y desaloja al otro. El invariante es: ningún cluster los contiene VIVOS
    // a ambos, y la historia se preserva (filas con removed_at, jamás DELETE).
    const memberRows = await db
      .getDb()
      .select()
      .from(db.schema.personClusterMembers)
      .where(eq(db.schema.personClusterMembers.clusterId, clusterId));
    expect(memberRows.length).toBeGreaterThanOrEqual(2);
    expect(memberRows.some((r) => r.removedAt !== null)).toBe(true); // historia preservada
    const liveA = await clusters.liveClusterOf(prnA);
    const liveB = await clusters.liveClusterOf(prnB);
    expect(liveA).not.toBeNull();
    expect(liveB).not.toBeNull();
    expect(liveA).not.toBe(liveB); // separados: ya no comparten cluster vivo

    const sweptPrns = personRecords.takeMatcherSweepCalls().flat();
    expect(sweptPrns).toContain(prnA);
    expect(sweptPrns).toContain(prnB);

    await matcher.processMatcherMessage({ prn: prnA }); // misma clase (name_age_exact) → no reabre.
    const finalLink = await rawLink(linkId);
    expect(finalLink!.status).toBe("rejected");
  });

  it("403 con solo person:review (falta person:merge)", async () => {
    const { token: reviewToken } = await makeUserWithCaps(["person:review"]);
    const t = token();
    const idA = await seedMissing({ name: `DEMO UnmergeAuth A ${t}` });
    const idB = await seedMissing({ name: `DEMO UnmergeAuth B ${t}` });
    const prnA = await prnFor("missing_report", idA);
    const prnB = await prnFor("missing_report", idB);
    const linkId = await seedProposedLink(prnA, prnB);
    await request(app).post(`${BASE}/${linkId}/decision`).set("Authorization", `Bearer ${reviewToken}`).send({ decision: "confirmar" });

    const res = await request(app).post(`${BASE}/${linkId}/unmerge`).set("Authorization", `Bearer ${reviewToken}`).send({});
    expect(res.status).toBe(403);
  });
});

describe("Fusión anclada (R18) — TOCTOU", () => {
  it("revisor SIN person:merge confirma un puente entre dos clusters de 2 → revierte (proposed, cero decisiones, 403); CON person:merge → fusiona en el cluster MÁS ANTIGUO, audita cluster.merge", async () => {
    const { token: reviewToken } = await makeUserWithCaps(["person:review"]);
    const { token: mergeToken } = await makeUserWithCaps(["person:review", "person:merge"]);
    const t = token();

    const [idA, idB, idC, idD] = await Promise.all([
      seedMissing({ name: `DEMO Anchor A ${t}` }),
      seedMissing({ name: `DEMO Anchor B ${t}` }),
      seedMissing({ name: `DEMO Anchor C ${t}` }),
      seedMissing({ name: `DEMO Anchor D ${t}` }),
    ]);
    const [prnA, prnB, prnC, prnD] = await Promise.all([
      prnFor("missing_report", idA),
      prnFor("missing_report", idB),
      prnFor("missing_report", idC),
      prnFor("missing_report", idD),
    ]);

    const linkAB = await seedProposedLink(prnA, prnB);
    await request(app).post(`${BASE}/${linkAB}/decision`).set("Authorization", `Bearer ${reviewToken}`).send({ decision: "confirmar" });
    const clusterAB = (await clusters.liveClusterOf(prnA))!;

    const linkCD = await seedProposedLink(prnC, prnD);
    await request(app).post(`${BASE}/${linkCD}/decision`).set("Authorization", `Bearer ${reviewToken}`).send({ decision: "confirmar" });
    const clusterCD = (await clusters.liveClusterOf(prnC))!;
    expect(clusterCD).not.toBe(clusterAB);

    const bridgeLinkId = await seedProposedLink(prnB, prnC);

    const denied = await request(app).post(`${BASE}/${bridgeLinkId}/decision`).set("Authorization", `Bearer ${reviewToken}`).send({ decision: "confirmar" });
    expect(denied.status).toBe(403);

    const revertedLink = await rawLink(bridgeLinkId);
    expect(revertedLink!.status).toBe("proposed");
    expect(await decisionsFor(bridgeLinkId)).toHaveLength(0);

    const granted = await request(app).post(`${BASE}/${bridgeLinkId}/decision`).set("Authorization", `Bearer ${mergeToken}`).send({ decision: "confirmar" });
    expect(granted.status).toBe(200);

    const mergedCluster = await clusters.liveClusterOf(prnB);
    expect(mergedCluster).toBe(clusterAB); // el más antiguo de los dos.
    expect(new Set(await clusters.liveMembersOf(clusterAB))).toEqual(new Set([prnA, prnB, prnC, prnD]));

    const mergeAudits = await auditRowsFor("cluster.merge", bridgeLinkId);
    expect(mergeAudits).toHaveLength(1);
  });
});

describe("runClusterInvariantChecks — reparo (a): extremos de link confirmado en clusters distintos", () => {
  it("un link 'confirmed' cuyos extremos viven en DOS clusters vivos distintos se repara a UN solo cluster compartido", async () => {
    const t = token();
    const idA = await seedMissing({ name: `DEMO EndpointRepair A ${t}` });
    const idB = await seedMissing({ name: `DEMO EndpointRepair B ${t}` });
    const prnA = await prnFor("missing_report", idA);
    const prnB = await prnFor("missing_report", idB);

    // Estado roto fabricado a mano (nunca ocurriría vía decideLink, que
    // recompute-a el cluster como parte del mismo protocolo): el link YA
    // está 'confirmed', pero cada extremo vive en su propio cluster vivo
    // (sin relación entre sí) — exactamente el invariante que (a) vigila.
    await seedConfirmedLinkDirect(prnA, prnB);
    const clusterX = await seedCluster();
    const clusterY = await seedCluster();
    await seedLiveMembership(prnA, clusterX);
    await seedLiveMembership(prnB, clusterY);

    expect(await clusters.liveClusterOf(prnA)).toBe(clusterX);
    expect(await clusters.liveClusterOf(prnB)).toBe(clusterY);

    const result = await personLinksService.repairConfirmedLinkEndpoints();
    expect(result.repaired).toBeGreaterThanOrEqual(1);

    const finalClusterA = await clusters.liveClusterOf(prnA);
    const finalClusterB = await clusters.liveClusterOf(prnB);
    expect(finalClusterA).not.toBeNull();
    expect(finalClusterA).toBe(finalClusterB);
  });
});

describe("runClusterInvariantChecks — reparo (b): miembro inalcanzable dentro de un cluster", () => {
  it("dos miembros vivos del MISMO cluster sin ningún link confirmado entre ellos → el reparo separa al menos uno a su propio cluster", async () => {
    const t = token();
    const idC = await seedMissing({ name: `DEMO Stray C ${t}` });
    const idD = await seedMissing({ name: `DEMO Stray D ${t}` });
    const prnC = await prnFor("missing_report", idC);
    const prnD = await prnFor("missing_report", idD);

    // Estado roto fabricado a mano: ambos PRNs viven, vivos, en el MISMO
    // cluster, pero no existe NINGÚN link confirmado que los una (ni
    // directo ni transitivo) — la caminata de conectividad de (b) debe
    // detectar que no son mutuamente alcanzables y desalojar al "extraño".
    const clusterZ = await seedCluster();
    await seedLiveMembership(prnC, clusterZ);
    await seedLiveMembership(prnD, clusterZ);

    expect(await clusters.liveClusterOf(prnC)).toBe(clusterZ);
    expect(await clusters.liveClusterOf(prnD)).toBe(clusterZ);

    const result = await personLinksService.repairClusterConnectivity({ timeBudgetMs: 5_000 });
    expect(result.repaired).toBeGreaterThanOrEqual(1);

    const liveC = await clusters.liveClusterOf(prnC);
    const liveD = await clusters.liveClusterOf(prnD);
    // Ya no ambos siguen vivos en clusterZ a la vez — el reparo desalojó al
    // miembro "extraño" (cuál de los dos exactamente depende del orden en
    // que liveMembersOf devuelve la fila semilla del BFS; el invariante que
    // importa es que ya no comparten cluster sin evidencia que los una).
    expect(liveC === clusterZ && liveD === clusterZ).toBe(false);
  });
});

describe("runClusterInvariantChecks — reparo (c): status sin decisión", () => {
  it("un link puesto 'confirmed' a mano SIN fila de decisión se revierte a 'proposed'", async () => {
    const t = token();
    const idA = await seedMissing({ name: `DEMO Repair A ${t}` });
    const idB = await seedMissing({ name: `DEMO Repair B ${t}` });
    const prnA = await prnFor("missing_report", idA);
    const prnB = await prnFor("missing_report", idB);
    const linkId = await seedProposedLink(prnA, prnB);
    await db.getDb().update(db.schema.personLinks).set({ status: "confirmed" }).where(eq(db.schema.personLinks.id, linkId));

    const result = await personLinksService.repairUndecidedStatuses();
    expect(result.reverted).toBeGreaterThanOrEqual(1);

    const after = await rawLink(linkId);
    expect(after!.status).toBe("proposed");
  });

  it("un link 'confirmed' CON su fila de decisión NO se toca", async () => {
    const { token: authToken } = await makeUserWithCaps(["person:review"]);
    const t = token();
    const idA = await seedMissing({ name: `DEMO RepairOk A ${t}` });
    const idB = await seedMissing({ name: `DEMO RepairOk B ${t}` });
    const prnA = await prnFor("missing_report", idA);
    const prnB = await prnFor("missing_report", idB);
    const linkId = await seedProposedLink(prnA, prnB);
    await request(app).post(`${BASE}/${linkId}/decision`).set("Authorization", `Bearer ${authToken}`).send({ decision: "confirmar" });

    await personLinksService.repairUndecidedStatuses();
    const after = await rawLink(linkId);
    expect(after!.status).toBe("confirmed");
  });
});

describe("matriz de capacidades — person-links", () => {
  it("person:search puede leer la cola; decidir con solo person:search → 403; sin auth → 401", async () => {
    const { token: searchOnly } = await makeUserWithCaps(["person:search"]);

    const queueRes = await request(app).get(`${BASE}/queue`).set("Authorization", `Bearer ${searchOnly}`);
    expect(queueRes.status).toBe(200);

    const t = token();
    const idA = await seedMissing({ name: `DEMO Matrix A ${t}` });
    const idB = await seedMissing({ name: `DEMO Matrix B ${t}` });
    const prnA = await prnFor("missing_report", idA);
    const prnB = await prnFor("missing_report", idB);
    const linkId = await seedProposedLink(prnA, prnB);

    const decideRes = await request(app).post(`${BASE}/${linkId}/decision`).set("Authorization", `Bearer ${searchOnly}`).send({ decision: "confirmar" });
    expect(decideRes.status).toBe(403);

    const anonRes = await request(app).get(`${BASE}/queue`);
    expect(anonRes.status).toBe(401);
  });

  it("unmerge exige person:merge, no basta person:review; búsqueda de registros exige person:search", async () => {
    const { token: reviewOnly } = await makeUserWithCaps(["person:review"]);
    const res = await request(app).post(`${BASE}/${randomUUID()}/unmerge`).set("Authorization", `Bearer ${reviewOnly}`).send({});
    expect(res.status).toBe(403);

    const searchRes = await request(app).get(`${BASE}/records/search?q=demo`);
    expect(searchRes.status).toBe(401);
  });
});

describe("orden del par (R16/propose)", () => {
  it("proponer con (B,A) produce la MISMA fila ordenada que (A,B); un INSERT directo con el par invertido viola el CHECK de la DB", async () => {
    const { token: authToken } = await makeUserWithCaps(["person:review"]);
    const t = token();
    const idA = await seedMissing({ name: `DEMO Order A ${t}` });
    const idB = await seedMissing({ name: `DEMO Order B ${t}` });
    const prnA = await prnFor("missing_report", idA);
    const prnB = await prnFor("missing_report", idB);
    const [orderedA, orderedB] = matcherPropose.orderPair(prnA, prnB);

    const res = await request(app)
      .post(`${BASE}/propose`)
      .set("Authorization", `Bearer ${authToken}`)
      .send({ prnA: prnB, prnB: prnA }); // orden invertido a propósito
    expect(res.status).toBe(201);
    expect(res.body.item.prnA).toBe(orderedA);
    expect(res.body.item.prnB).toBe(orderedB);

    await expect(
      db.getDb().insert(db.schema.personLinks).values({
        id: randomUUID(),
        prnA: orderedB, // invertido: prn_a > prn_b
        prnB: orderedA,
        status: "proposed",
        score: null,
        evidence: {},
        evidenceClass: "manual",
        method: "manual",
        matcherVersion: null,
        proposedAt: Date.now(),
      ...testTenantOwnership(),
    }),
    ).rejects.toThrow();
  });
});

describe("POST /propose — R16", () => {
  it("400 con el mismo PRN en ambos lados", async () => {
    const { token: authToken } = await makeUserWithCaps(["person:review"]);
    const t = token();
    const id = await seedMissing({ name: `DEMO SamePrn ${t}` });
    const prn = await prnFor("missing_report", id);
    const res = await request(app).post(`${BASE}/propose`).set("Authorization", `Bearer ${authToken}`).send({ prnA: prn, prnB: prn });
    expect(res.status).toBe(400);
  });

  it("400 con un PRN que no existe", async () => {
    const { token: authToken } = await makeUserWithCaps(["person:review"]);
    const t = token();
    const id = await seedMissing({ name: `DEMO UnknownPrn ${t}` });
    const prn = await prnFor("missing_report", id);
    const res = await request(app)
      .post(`${BASE}/propose`)
      .set("Authorization", `Bearer ${authToken}`)
      .send({ prnA: prn, prnB: "TC-ZZZZZZZZZ" });
    expect(res.status).toBe(400);
  });

  it("proponer el MISMO par dos veces (aún proposed) → 200 idempotente, la misma fila", async () => {
    const { token: authToken } = await makeUserWithCaps(["person:review"]);
    const t = token();
    const idA = await seedMissing({ name: `DEMO ProposeTwice A ${t}` });
    const idB = await seedMissing({ name: `DEMO ProposeTwice B ${t}` });
    const prnA = await prnFor("missing_report", idA);
    const prnB = await prnFor("missing_report", idB);

    const first = await request(app).post(`${BASE}/propose`).set("Authorization", `Bearer ${authToken}`).send({ prnA, prnB });
    expect(first.status).toBe(201);

    const second = await request(app).post(`${BASE}/propose`).set("Authorization", `Bearer ${authToken}`).send({ prnA, prnB });
    expect(second.status).toBe(200);
    expect(second.body.item.id).toBe(first.body.item.id);
  });

  it("proponer un par YA confirmado → 409", async () => {
    const { token: authToken } = await makeUserWithCaps(["person:review"]);
    const t = token();
    const idA = await seedMissing({ name: `DEMO ProposeConfirmed A ${t}` });
    const idB = await seedMissing({ name: `DEMO ProposeConfirmed B ${t}` });
    const prnA = await prnFor("missing_report", idA);
    const prnB = await prnFor("missing_report", idB);
    const linkId = await seedProposedLink(prnA, prnB);
    await request(app).post(`${BASE}/${linkId}/decision`).set("Authorization", `Bearer ${authToken}`).send({ decision: "confirmar" });

    const res = await request(app).post(`${BASE}/propose`).set("Authorization", `Bearer ${authToken}`).send({ prnA, prnB });
    expect(res.status).toBe(409);
  });
});

describe("scanNotesForPii", () => {
  it("detecta una nota sintética con dígitos consecutivos (≥6); una nota limpia no aparece", async () => {
    const { token: authToken } = await makeUserWithCaps(["person:review"]);
    const t = token();

    const idA = await seedMissing({ name: `DEMO Pii Dirty A ${t}` });
    const idB = await seedMissing({ name: `DEMO Pii Dirty B ${t}` });
    const prnA = await prnFor("missing_report", idA);
    const prnB = await prnFor("missing_report", idB);
    const dirtyLinkId = await seedProposedLink(prnA, prnB);

    const idC = await seedMissing({ name: `DEMO Pii Clean C ${t}` });
    const idD = await seedMissing({ name: `DEMO Pii Clean D ${t}` });
    const prnC = await prnFor("missing_report", idC);
    const prnD = await prnFor("missing_report", idD);
    const cleanLinkId = await seedProposedLink(prnC, prnD);

    await request(app)
      .post(`${BASE}/${dirtyLinkId}/decision`)
      .set("Authorization", `Bearer ${authToken}`)
      .send({ decision: "inseguro", note: "Cédula 12345678 coincide con el reporte previo." });
    await request(app)
      .post(`${BASE}/${cleanLinkId}/decision`)
      .set("Authorization", `Bearer ${authToken}`)
      .send({ decision: "inseguro", note: "Necesita revisión adicional del caso." });

    const scan = await personLinksService.scanNotesForPii();
    const dirtyDecisionId = (await decisionsFor(dirtyLinkId))[0]!.id;
    const cleanDecisionId = (await decisionsFor(cleanLinkId))[0]!.id;

    expect(scan.decisionOffenderIds).toContain(dirtyDecisionId);
    expect(scan.decisionOffenderIds).not.toContain(cleanDecisionId);
  });
});

describe("GET /records/search — R19", () => {
  it("busca por nombre y devuelve el registro; el salto exacto por PRN también resuelve", async () => {
    const { token: authToken } = await makeUserWithCaps(["person:search"]);
    const t = token();
    const uniqueName = `DEMO SearchUnique ${t}`;
    const id = await seedMissing({ name: uniqueName });
    const prn = await prnFor("missing_report", id);

    const byName = await request(app).get(`${BASE}/records/search`).query({ q: uniqueName }).set("Authorization", `Bearer ${authToken}`);
    expect(byName.status).toBe(200);
    expect((byName.body.results as { prn: string }[]).some((r) => r.prn === prn)).toBe(true);

    const byPrn = await request(app).get(`${BASE}/records/search`).query({ q: prn }).set("Authorization", `Bearer ${authToken}`);
    expect(byPrn.status).toBe(200);
    expect(byPrn.body.exactPrnMatch?.prn).toBe(prn);
  });
});

describe("GET /clusters/:clusterId — ficha", () => {
  it("devuelve miembros + historia de decisiones + status; 404 si no existe", async () => {
    const { token: authToken } = await makeUserWithCaps(["person:review", "person:search"]);
    const t = token();
    const idA = await seedMissing({ name: `DEMO Ficha A ${t}` });
    const idB = await seedMissing({ name: `DEMO Ficha B ${t}` });
    const prnA = await prnFor("missing_report", idA);
    const prnB = await prnFor("missing_report", idB);
    const linkId = await seedProposedLink(prnA, prnB);
    await request(app).post(`${BASE}/${linkId}/decision`).set("Authorization", `Bearer ${authToken}`).send({ decision: "confirmar" });
    const clusterId = (await clusters.liveClusterOf(prnA))!;

    const res = await request(app).get(`${BASE}/clusters/${clusterId}`).set("Authorization", `Bearer ${authToken}`);
    expect(res.status).toBe(200);
    expect(res.body.item.clusterId).toBe(clusterId);
    expect(res.body.item.members).toHaveLength(2);
    expect(res.body.item.decisions.length).toBeGreaterThanOrEqual(1);

    const notFound = await request(app).get(`${BASE}/clusters/${randomUUID()}`).set("Authorization", `Bearer ${authToken}`);
    expect(notFound.status).toBe(404);
  });
});
