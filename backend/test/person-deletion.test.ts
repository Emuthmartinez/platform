/**
 * U10 — tombstone de identidad en cascada al borrar un registro fuente (R21,
 * AE3): `services/person-records.ts:tombstonePersonRecord`, enganchado desde
 * la ruta DELETE hecha a mano (`routes/missing.ts`) y desde el hook
 * `onBeforeRemove` de la fábrica CRUD (`missing.resource.ts` /
 * `patients.resource.ts`).
 *
 * NO SE PUEDE CORRER en este entorno (sin node_modules) — escrito ANTES de
 * verificar con `tsc`/`vitest run`. Mismos idiomas de fixtures que
 * `test/person-links.test.ts` / `test/person-clusters.test.ts`: helpers
 * duplicados a propósito (convención ya establecida en este repo), tokens
 * aleatorios por nombre para que ningún test cruce con otro en la DB
 * compartida.
 *
 * `routes/missing.ts` usa el auth ADMIN LEGACY (`x-admin-token` ==
 * ADMIN_PASSWORD), no el JWT de `api/public/*` — así que `req.user` no existe
 * ahí (ver deviation en el reporte de U10: la atribución cae a `'admin'`).
 * `ADMIN_PASSWORD` no está seteado por `test/helpers.ts`; se fija aquí, ANTES
 * de cualquier import dinámico de `@/server` (que es lo que primero evalúa
 * `config/env`) — mismo patrón que `test/needs-http.test.ts`
 * (`RESPONSEGRID_API_KEY`).
 *
 * Requiere el stack local arriba (docker compose up): DATABASE_URL +
 * VALKEY_URL. PII sintética: nombres DEMO con token aleatorio, nunca datos
 * reales.
 */
import { randomUUID } from "crypto";
import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import "./helpers";
import request from "supertest";
import { makeUserWithCaps, testTenantOwnership} from "./helpers";

const ADMIN_TOKEN = "test-admin-password-u10-0123456789";
process.env.ADMIN_PASSWORD = ADMIN_TOKEN;

let app: import("express").Express;
let db: typeof import("@/db");
let personRecordsSvc: typeof import("@/services/person-records");
let clusters: typeof import("@/services/person-clusters");
let matcherPropose: typeof import("@/services/matcher/propose");

beforeAll(async () => {
  app = (await import("@/server")).app;
  db = await import("@/db");
  personRecordsSvc = await import("@/services/person-records");
  clusters = await import("@/services/person-clusters");
  matcherPropose = await import("@/services/matcher/propose");
});

// --------------------------------------------------------------- seeding ---

function token(): string {
  return randomUUID().slice(0, 8);
}

async function seedMissing(name: string): Promise<string> {
  const id = randomUUID();
  await db.getDb().insert(db.schema.missingPersons).values({
    id,
    name,
    createdAt: Date.now(),
      ...testTenantOwnership(),
    });
  return id;
}

async function makeHospital(): Promise<string> {
  const id = randomUUID();
  await db.getDb().insert(db.schema.hospitals).values({
    id,
    name: `DEMO Hospital Deletion ${id.slice(0, 8)}`,
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
  const prn = await personRecordsSvc.ensurePrn(recordType, recordId);
  if (!prn) throw new Error(`no se pudo estampar PRN de prueba (${recordType}/${recordId})`);
  return prn;
}

/** Siembra una fila `person_links` CONFIRMADA directamente (bypassa el
 *  protocolo de decisión — igual que test/person-clusters.test.ts: aquí se
 *  prueba el tombstone, no la ruta de decisión). Devuelve el linkId. */
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

async function registryRowByPrn(prn: string) {
  const rows = await db.getDb().select().from(db.schema.personRecords).where(eq(db.schema.personRecords.prn, prn));
  return rows[0] ?? null;
}

async function registryRowByRecord(recordType: string, recordId: string) {
  const rows = await db
    .getDb()
    .select()
    .from(db.schema.personRecords)
    .where(
      and(
        eq(db.schema.personRecords.recordType, recordType),
        eq(db.schema.personRecords.recordId, recordId),
      ),
    );
  return rows[0] ?? null;
}

// ------------------------------------------------------------------ tests ---

describe("DELETE /api/missing/:id — hoja de un cluster de 3 (R21/AE3)", () => {
  it("borrar una hoja: membresía con removed_at (historia preservada), link rescindido con decisión atribuida a 'admin', los dos restantes siguen compartiendo UN cluster vivo, person_records.removed_at, audit person.purge; regresión: suppression + missing.delete + forma de respuesta sin cambios", async () => {
    const t = token();
    const idA = await seedMissing(`DEMO Delete Leaf A ${t}`);
    const idB = await seedMissing(`DEMO Delete Leaf B ${t}`);
    const idC = await seedMissing(`DEMO Delete Leaf C ${t}`);
    const prnA = await prnFor("missing_report", idA);
    const prnB = await prnFor("missing_report", idB);
    const prnC = await prnFor("missing_report", idC);

    await seedConfirmedLink(prnA, prnB);
    await clusters.recomputeClusterFor(prnA);
    const linkBC = await seedConfirmedLink(prnB, prnC);
    await clusters.recomputeClusterFor(prnB);

    const clusterId = (await clusters.liveClusterOf(prnA))!;
    expect(new Set(await clusters.liveMembersOf(clusterId))).toEqual(new Set([prnA, prnB, prnC]));

    personRecordsSvc.takeMatcherSweepCalls(); // drena lo acumulado hasta aquí

    const res = await request(app).delete(`/api/missing/${idC}`).set("x-admin-token", ADMIN_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true }); // forma de respuesta sin cambios

    // C: membresía con removed_at (historia preservada), fuera de todo
    // cluster vivo.
    expect(await clusters.liveClusterOf(prnC)).toBeNull();
    const cMembershipRows = await db
      .getDb()
      .select()
      .from(db.schema.personClusterMembers)
      .where(eq(db.schema.personClusterMembers.prn, prnC));
    expect(cMembershipRows.length).toBeGreaterThan(0);
    expect(cMembershipRows.every((r) => r.removedAt !== null)).toBe(true);

    // link B-C: rescindido, decisión 'rescinded' atribuida a 'admin' (ruta
    // legacy sin req.user).
    const bcLink = await rawLink(linkBC);
    expect(bcLink!.status).toBe("rejected");
    const bcDecisions = await decisionsFor(linkBC);
    const rescinded = bcDecisions.find((d) => d.decision === "rescinded");
    expect(rescinded).toBeTruthy();
    expect(rescinded!.decidedBy).toBe("admin");

    // A y B siguen compartiendo UN cluster vivo.
    const liveA = await clusters.liveClusterOf(prnA);
    const liveB = await clusters.liveClusterOf(prnB);
    expect(liveA).not.toBeNull();
    expect(liveA).toBe(liveB);
    expect(await clusters.liveMembersOf(liveA!)).toHaveLength(2);

    // person_records.removed_at
    const prRow = await registryRowByPrn(prnC);
    expect(prRow?.removedAt).not.toBeNull();

    // audit person.purge
    const purgeAudits = await auditRowsFor("person.purge", prnC);
    expect(purgeAudits).toHaveLength(1);

    // Regresión: missing.delete audit sin cambios + suppression escrita.
    const deleteAudits = await auditRowsFor("missing.delete", idC);
    expect(deleteAudits).toHaveLength(1);
    const suppression = await db
      .getDb()
      .select()
      .from(db.schema.missingPersonSuppressions)
      .where(eq(db.schema.missingPersonSuppressions.legacyId, idC));
    expect(suppression).toHaveLength(1);
  });
});

describe("DELETE /api/public/missing/:id — cut-vertex (revisión adversarial del plan)", () => {
  it("cluster {A,B,C,D,E} con A-B,B-C,B-D,D-E confirmados: borrar B parte en TRES clusters vivos ({A},{C},{D,E}); D-E queda intacto; matcher barrido para A,C,D (no para E)", async () => {
    const { token: authToken } = await makeUserWithCaps(["missing:delete"]);
    const t = token();
    const [idA, idB, idC, idD, idE] = await Promise.all([
      seedMissing(`DEMO CutVertex A ${t}`),
      seedMissing(`DEMO CutVertex B ${t}`),
      seedMissing(`DEMO CutVertex C ${t}`),
      seedMissing(`DEMO CutVertex D ${t}`),
      seedMissing(`DEMO CutVertex E ${t}`),
    ]);
    const [prnA, prnB, prnC, prnD, prnE] = await Promise.all([
      prnFor("missing_report", idA),
      prnFor("missing_report", idB),
      prnFor("missing_report", idC),
      prnFor("missing_report", idD),
      prnFor("missing_report", idE),
    ]);

    const linkAB = await seedConfirmedLink(prnA, prnB);
    await clusters.recomputeClusterFor(prnA);
    const linkBC = await seedConfirmedLink(prnB, prnC);
    await clusters.recomputeClusterFor(prnB);
    const linkBD = await seedConfirmedLink(prnB, prnD);
    await clusters.recomputeClusterFor(prnB);
    const linkDE = await seedConfirmedLink(prnD, prnE);
    await clusters.recomputeClusterFor(prnD);

    const clusterId = (await clusters.liveClusterOf(prnA))!;
    expect(new Set(await clusters.liveMembersOf(clusterId))).toEqual(
      new Set([prnA, prnB, prnC, prnD, prnE]),
    );

    personRecordsSvc.takeMatcherSweepCalls(); // drena lo acumulado hasta aquí

    const res = await request(app)
      .delete(`/api/public/missing/${idB}`)
      .set("Authorization", `Bearer ${authToken}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true }); // forma de respuesta sin cambios

    // B: fuera de todo cluster vivo.
    expect(await clusters.liveClusterOf(prnB)).toBeNull();

    // TRES clusters vivos distintos: {A}, {C}, {D,E}. Nadie comparte cluster
    // vivo con un no-vecino de B (la partición en 3 conjuntos disjuntos lo
    // garantiza).
    const liveA = (await clusters.liveClusterOf(prnA))!;
    const liveC = (await clusters.liveClusterOf(prnC))!;
    const liveD = (await clusters.liveClusterOf(prnD))!;
    const liveE = await clusters.liveClusterOf(prnE);
    expect(liveA).not.toBeNull();
    expect(liveC).not.toBeNull();
    expect(liveD).not.toBeNull();
    expect(liveE).toBe(liveD); // D y E siguen juntos.
    expect(new Set([liveA, liveC, liveD]).size).toBe(3); // tres clusters distintos.
    expect(await clusters.liveMembersOf(liveA)).toEqual([prnA]);
    expect(await clusters.liveMembersOf(liveC)).toEqual([prnC]);
    expect(new Set(await clusters.liveMembersOf(liveD))).toEqual(new Set([prnD, prnE]));

    // A-B, B-C, B-D rescindidos (decisión 'rescinded' atribuida al actor
    // real); D-E intacto (no tocaba a B).
    for (const linkId of [linkAB, linkBC, linkBD]) {
      const link = await rawLink(linkId);
      expect(link!.status).toBe("rejected");
      const decisions = await decisionsFor(linkId);
      expect(decisions.some((d) => d.decision === "rescinded")).toBe(true);
    }
    const linkDERow = await rawLink(linkDE);
    expect(linkDERow!.status).toBe("confirmed");
    expect(await decisionsFor(linkDE)).toHaveLength(0);

    // Sweep del matcher: A, C, D (vecinos CONFIRMADOS directos de B) — no E
    // (solo vecino de D, no de B).
    const swept = new Set(personRecordsSvc.takeMatcherSweepCalls().flat());
    expect(swept.has(prnA)).toBe(true);
    expect(swept.has(prnC)).toBe(true);
    expect(swept.has(prnD)).toBe(true);
    expect(swept.has(prnE)).toBe(false);

    // audit person.purge para B
    const purgeAudits = await auditRowsFor("person.purge", prnB);
    expect(purgeAudits).toHaveLength(1);
  });
});

describe("DELETE /api/missing/:id — registro sin vínculos", () => {
  it("tombstone del registro únicamente: sin cluster/membresía que tocar, sin fallo en el audit person.purge", async () => {
    const t = token();
    const id = await seedMissing(`DEMO Delete Unlinked ${t}`);
    const prn = await prnFor("missing_report", id);
    // Nunca se llamó recomputeClusterFor: este PRN no tiene membresía de
    // cluster todavía (caso real más común: un registro recién estampado sin
    // decisión de vínculo).
    expect(await clusters.liveClusterOf(prn)).toBeNull();

    const res = await request(app).delete(`/api/missing/${id}`).set("x-admin-token", ADMIN_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });

    expect(await clusters.liveClusterOf(prn)).toBeNull(); // sin churn de cluster
    const prRow = await registryRowByPrn(prn);
    expect(prRow?.removedAt).not.toBeNull();

    const purgeAudits = await auditRowsFor("person.purge", prn);
    expect(purgeAudits).toHaveLength(1);
  });
});

describe("DELETE /api/missing/:id — registro sin PRN (nunca estampado)", () => {
  it("borrado normal (missing.delete audit + suppression), sin audit person.purge, sin error", async () => {
    // Insert directo (bypassa addMissing/ensurePrn): nunca tuvo PRN.
    const id = randomUUID();
    await db.getDb().insert(db.schema.missingPersons).values({
      id,
      name: `DEMO Delete NoPrn ${token()}`,
      createdAt: Date.now(),
      ...testTenantOwnership(),
    });
    expect(await registryRowByRecord("missing_report", id)).toBeNull();

    const res = await request(app).delete(`/api/missing/${id}`).set("x-admin-token", ADMIN_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });

    const deleteAudits = await auditRowsFor("missing.delete", id);
    expect(deleteAudits).toHaveLength(1); // el borrado normal sigue auditado

    const purgeAudits = await auditRowsFor("person.purge", id);
    expect(purgeAudits).toHaveLength(0); // sin PRN -> sin audit person.purge
  });
});

describe("DELETE /api/public/patients/:id — mismos efectos de tombstone vía la fábrica CRUD", () => {
  it("paciente enlazado a un missing report: link rescindido (decisión atribuida al actor real), cluster recomputado para el vecino, person_records.removed_at, audit person.purge, matcher barrido", async () => {
    const { token: authToken, id: actorId } = await makeUserWithCaps(["patient:delete"]);
    const t = token();
    const hospitalId = await makeHospital();
    const missingId = await seedMissing(`DEMO Patient Link Missing ${t}`);
    const patientId = await seedPatient(hospitalId, `DEMO Patient Link Patient ${t}`);
    const prnMissing = await prnFor("missing_report", missingId);
    const prnPatient = await prnFor("hospital_patient", patientId);

    const linkId = await seedConfirmedLink(prnMissing, prnPatient);
    await clusters.recomputeClusterFor(prnMissing);
    expect(await clusters.liveClusterOf(prnMissing)).toBe(await clusters.liveClusterOf(prnPatient));

    personRecordsSvc.takeMatcherSweepCalls();

    const res = await request(app)
      .delete(`/api/public/patients/${patientId}`)
      .set("Authorization", `Bearer ${authToken}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });

    const link = await rawLink(linkId);
    expect(link!.status).toBe("rejected");
    const decisions = await decisionsFor(linkId);
    const rescinded = decisions.find((d) => d.decision === "rescinded");
    expect(rescinded).toBeTruthy();
    expect(rescinded!.decidedBy).toBe(actorId);

    expect(await clusters.liveClusterOf(prnPatient)).toBeNull();
    expect(await clusters.liveClusterOf(prnMissing)).not.toBeNull();

    const prRow = await registryRowByPrn(prnPatient);
    expect(prRow?.removedAt).not.toBeNull();

    const purgeAudits = await auditRowsFor("person.purge", prnPatient);
    expect(purgeAudits).toHaveLength(1);
    expect(purgeAudits[0]!.actorUserId).toBe(actorId);

    const swept = new Set(personRecordsSvc.takeMatcherSweepCalls().flat());
    expect(swept.has(prnMissing)).toBe(true);
  });
});
