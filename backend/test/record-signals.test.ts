/**
 * U14 — `record_status_signals` ("señal, no verdad", R24/R25/R26/AE4):
 *   - CHARACTERIZATION (primer bloque, escrito ANTES de tocar el comportamiento
 *     de `upsertExternalMissingBatch`): el merge de campos NO-status
 *     (description/lastSeen/photoUrl vía COALESCE) es EXACTAMENTE el mismo
 *     antes y después de U14 — solo `status`/`resolution_note`/`resolved_at`
 *     dejan de pisarse en un re-sync sobre una fila existente.
 *   - Status hold: un re-sync que reclama un status distinto al guardado NO
 *     lo pisa; crea/actualiza UNA señal pendiente (idempotente, nunca apila).
 *   - Identidad en lote (R24): un batch de 50 registros nuevos estampa PRN
 *     para los 50 y encola el matcher sweep en UNA sola llamada por lote.
 *   - Decisión (R25/R26): confirmar aplica el status reclamado al registro
 *     fuente por el camino auditado existente (markMissingFound/
 *     restoreMissing); descartar lo deja intacto; nota obligatoria solo para
 *     descartar; carrera de dos revisores -> un 200 + un 409; replay del
 *     mismo revisor -> 200 idempotente; confirmar una transición YA aplicada
 *     a mano -> no-op armónico.
 *   - AE4: confirmar una señal aplica SOLO al registro que identifica — un
 *     reporte LOCAL vinculado en el MISMO cluster confirmado no se toca.
 *   - Matriz de capacidades: listar exige person:search; decidir exige
 *     person:review.
 *
 * NO SE PUEDE CORRER en este entorno (sin node_modules) — escrito ANTES de
 * verificar con `tsc`/`vitest run`, y el bloque CHARACTERIZATION se escribió
 * ANTES de tocar `upsertExternalMissingBatch` (ver docs/plans, unidad U14:
 * "characterize current merge behavior with tests BEFORE changing it").
 * Mismos idiomas de fixtures que `test/person-links.test.ts` /
 * `test/partner-sync.test.ts`: helpers duplicados a propósito (convención ya
 * establecida en este repo), tokens aleatorios por nombre para que ningún
 * test cruce con otro en la DB compartida, `Promise.allSettled` para probar
 * la carrera de claim.
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

let app: import("express").Express;
let db: typeof import("@/db");
let missingService: typeof import("@/services/missing");
let personRecords: typeof import("@/services/person-records");
let personLinksService: typeof import("@/services/person-links");
let matcherPropose: typeof import("@/services/matcher/propose");

beforeAll(async () => {
  app = (await import("@/server")).app;
  db = await import("@/db");
  missingService = await import("@/services/missing");
  personRecords = await import("@/services/person-records");
  personLinksService = await import("@/services/person-links");
  matcherPropose = await import("@/services/matcher/propose");
});

// --------------------------------------------------------------- seeding ---

function token(): string {
  return randomUUID().slice(0, 8);
}

/** Reporte LOCAL (no-partner: sin source/externalId) — mismo idioma que
 *  `seedMissing` de person-links.test.ts. */
async function seedLocalMissing(opts: { name: string }): Promise<string> {
  const id = randomUUID();
  await db.getDb().insert(db.schema.missingPersons).values({
    id,
    name: opts.name,
    createdAt: Date.now(),
      ...testTenantOwnership(),
    });
  return id;
}

async function findMissingBySourceAndExternalId(source: string, externalId: string) {
  const rows = await db
    .getDb()
    .select()
    .from(db.schema.missingPersons)
    .where(
      and(
        eq(db.schema.missingPersons.source, source),
        eq(db.schema.missingPersons.externalId, externalId),
      ),
    );
  return rows[0] ?? null;
}

async function findMissingById(id: string) {
  const rows = await db.getDb().select().from(db.schema.missingPersons).where(eq(db.schema.missingPersons.id, id));
  return rows[0] ?? null;
}

async function pendingSignalsFor(prn: string) {
  return db
    .getDb()
    .select()
    .from(db.schema.recordStatusSignals)
    .where(
      and(
        eq(db.schema.recordStatusSignals.prn, prn),
        eq(db.schema.recordStatusSignals.status, "pending"),
      ),
    );
}

const BASE = "/api/public/record-signals";

// ------------------------------------------------------------------ tests ---

describe("CHARACTERIZATION (escrito ANTES de tocar upsertExternalMissingBatch) — merge de campos NO-status", () => {
  it("re-sync: description/lastSeen NUEVOS pisan (EXCLUDED gana); photoUrl OMITIDO conserva el que ya había (COALESCE) — igual antes y después de U14", async () => {
    const t = token();
    const source = `synthetic.characterization.${t}`;
    const externalId = `DEMO-char-${t}`;

    const first = await missingService.upsertExternalMissingBatch([
      {
        externalId,
        source,
        name: `DEMO Persona Char ${t}`,
        description: "Descripción original",
        lastSeen: "Barrio Original",
        photoUrl: "https://cdn.example.test/original.jpg",
        status: "active",
      },
    ]);
    expect(first).toMatchObject({ inserted: 1, updated: 0, skipped: 0, errors: 0 });

    const afterFirst = await findMissingBySourceAndExternalId(source, externalId);
    expect(afterFirst).toBeTruthy();
    expect(afterFirst!.description).toBe("Descripción original");
    expect(afterFirst!.photoExternalUrl).toBe("https://cdn.example.test/original.jpg");

    // Re-sync: description/lastSeen NUEVOS (deben pisar, EXCLUDED gana);
    // photoUrl OMITIDO (debe conservar el guardado vía COALESCE); status SIN
    // transición (mismo 'active') -> no debe generar señal.
    const second = await missingService.upsertExternalMissingBatch([
      {
        externalId,
        source,
        name: `DEMO Persona Char ${t}`,
        description: "Descripción actualizada",
        lastSeen: "Barrio Nuevo",
        status: "active",
      },
    ]);
    expect(second).toMatchObject({ inserted: 0, updated: 1, skipped: 0, errors: 0 });

    const afterSecond = await findMissingBySourceAndExternalId(source, externalId);
    expect(afterSecond!.description).toBe("Descripción actualizada");
    expect(afterSecond!.lastSeen).toBe("Barrio Nuevo");
    expect(afterSecond!.photoExternalUrl).toBe("https://cdn.example.test/original.jpg");
    expect(afterSecond!.status).toBe("active");

    const prn = await personRecords.ensurePrn("missing_report", afterSecond!.id);
    expect(await pendingSignalsFor(prn!)).toHaveLength(0);
  });
});

describe("U14 — status hold (R24/R25/R26): un upsert externo NUNCA pisa el status guardado", () => {
  it("partner re-sync active->found: el status guardado NO cambia; crea UNA señal pendiente (claimed_status='found', source y PRN correctos); repetir el re-sync no apila (refresca)", async () => {
    const t = token();
    const source = `partner:demo-resync-${t}@test.local`;
    const externalId = `DEMO-resync-${t}`;

    const created = await missingService.upsertExternalMissingBatch([
      { externalId, source, name: `DEMO Resync ${t}`, status: "active" },
    ]);
    expect(created).toMatchObject({ inserted: 1 });

    const row = await findMissingBySourceAndExternalId(source, externalId);
    expect(row!.status).toBe("active");
    const prn = await personRecords.ensurePrn("missing_report", row!.id);
    expect(prn).toBeTruthy();

    const resynced = await missingService.upsertExternalMissingBatch([
      {
        externalId,
        source,
        name: `DEMO Resync ${t}`,
        status: "found",
        resolutionNote: "Localizado por Cruz Roja",
      },
    ]);
    expect(resynced).toMatchObject({ inserted: 0, updated: 1 });

    const rowAfter = await findMissingBySourceAndExternalId(source, externalId);
    expect(rowAfter!.status).toBe("active"); // NO se pisó
    expect(rowAfter!.resolutionNote).toBeNull();
    expect(rowAfter!.resolvedAt).toBeNull();

    const pending = await pendingSignalsFor(prn!);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ claimedStatus: "found", source, status: "pending", prn });
    const payload1 = pending[0]!.payload as { resolutionNote?: string; reportedAt: number };
    expect(payload1.resolutionNote).toBe("Localizado por Cruz Roja");

    // Repetir el MISMO re-sync -> sigue habiendo UNA sola señal (refrescada).
    await new Promise((r) => setTimeout(r, 5));
    const resyncedAgain = await missingService.upsertExternalMissingBatch([
      {
        externalId,
        source,
        name: `DEMO Resync ${t}`,
        status: "found",
        resolutionNote: "Localizado por Cruz Roja",
      },
    ]);
    expect(resyncedAgain).toMatchObject({ inserted: 0, updated: 1 });

    const pendingAfter = await pendingSignalsFor(prn!);
    expect(pendingAfter).toHaveLength(1);
    expect(pendingAfter[0]!.id).toBe(pending[0]!.id); // MISMA fila, no una nueva
    const payload2 = pendingAfter[0]!.payload as { reportedAt: number };
    expect(payload2.reportedAt).toBeGreaterThan(payload1.reportedAt);
  });

  it("registro NUEVO que llega ya 'found' -> se guarda found, SIN señal (estado inicial != transición)", async () => {
    const t = token();
    const source = `partner:demo-new-found-${t}@test.local`;
    const externalId = `DEMO-new-found-${t}`;

    const created = await missingService.upsertExternalMissingBatch([
      { externalId, source, name: `DEMO Nuevo Found ${t}`, status: "found", resolutionNote: "Ya localizado" },
    ]);
    expect(created).toMatchObject({ inserted: 1 });

    const row = await findMissingBySourceAndExternalId(source, externalId);
    expect(row!.status).toBe("found");
    const prn = await personRecords.ensurePrn("missing_report", row!.id);
    expect(await pendingSignalsFor(prn!)).toHaveLength(0);
  });
});

describe("U14 — identidad en lote (R24): 50 registros -> PRN + matcher sweep en lote", () => {
  it("50 registros nuevos -> los 50 tienen fila en person_records; el matcher sweep se encola en UNA sola llamada con los 50 PRNs (no un round-trip por registro)", async () => {
    const t = token();
    const source = `synthetic.batch.${t}`;
    personRecords.takeMatcherSweepCalls(); // drena lo acumulado por tests previos

    const people = Array.from({ length: 50 }, (_, i) => ({
      externalId: `DEMO-batch50-${t}-${i}`,
      source,
      name: `DEMO Batch ${t} ${i}`,
      status: "active" as const,
    }));

    const result = await missingService.upsertExternalMissingBatch(people);
    expect(result).toMatchObject({ inserted: 50, updated: 0, skipped: 0, errors: 0 });

    const calls = personRecords.takeMatcherSweepCalls();
    expect(calls).toHaveLength(1); // UN solo enqueueMatcherSweep para todo el batch
    expect(calls[0]).toHaveLength(50);

    for (const p of people) {
      const row = await findMissingBySourceAndExternalId(source, p.externalId);
      expect(row).toBeTruthy();
      const ref = await db
        .getDb()
        .select()
        .from(db.schema.personRecords)
        .where(eq(db.schema.personRecords.recordId, row!.id));
      expect(ref).toHaveLength(1);
      expect(ref[0]!.recordType).toBe("missing_report");
    }
  });
});

describe("POST /:signalId/decision — confirmar: aplica claimedStatus al registro fuente vía el camino auditado (AE4: el vinculado no se toca)", () => {
  it("confirmar found: el registro del socio queda 'found' (markMissingFound); un reporte LOCAL vinculado en el MISMO cluster confirmado sigue 'active'; auditoría signal.confirm", async () => {
    const { token: authToken, id: actorId } = await makeUserWithCaps(["person:review", "person:search"]);
    const t = token();

    // Reporte LOCAL + registro del socio, YA vinculados en un cluster
    // CONFIRMADO (un revisor previo ya dijo "es la misma persona").
    const localId = await seedLocalMissing({ name: `DEMO Local Vinculado ${t}` });
    const localPrn = await personRecords.ensurePrn("missing_report", localId);

    const source = `partner:demo-confirm-${t}@test.local`;
    const externalId = `DEMO-confirm-${t}`;
    await missingService.upsertExternalMissingBatch([
      { externalId, source, name: `DEMO Socio Vinculado ${t}`, status: "active" },
    ]);
    const partnerRow = await findMissingBySourceAndExternalId(source, externalId);
    const partnerPrn = await personRecords.ensurePrn("missing_report", partnerRow!.id);

    const [prnA, prnB] = matcherPropose.orderPair(localPrn!, partnerPrn!);
    const linkId = randomUUID();
    await db.getDb().insert(db.schema.personLinks).values({
      id: linkId,
      prnA,
      prnB,
      status: "proposed",
      score: 0.9,
      evidence: {},
      evidenceClass: "manual",
      method: "manual",
      matcherVersion: null,
      proposedAt: Date.now(),
      ...testTenantOwnership(),
    });
    await personLinksService.decideLink({
      linkId,
      decision: "confirmar",
      note: "Mismo registro, confirmado en cluster de prueba (U14/AE4).",
      actorId,
      actorHasMergeCapability: true,
    });

    // El socio reporta 'found' -> señal pendiente sobre partnerPrn.
    await missingService.upsertExternalMissingBatch([
      {
        externalId,
        source,
        name: `DEMO Socio Vinculado ${t}`,
        status: "found",
        resolutionNote: "Confirmado por el socio",
      },
    ]);
    const pending = await pendingSignalsFor(partnerPrn!);
    expect(pending).toHaveLength(1);
    const signalId = pending[0]!.id;

    const res = await request(app)
      .post(`${BASE}/${signalId}/decision`)
      .set("Authorization", `Bearer ${authToken}`)
      .send({ decision: "confirmar" });
    expect(res.status).toBe(200);
    expect(res.body.idempotentReplay).toBe(false);
    expect(res.body.item.status).toBe("confirmed");
    expect(res.body.item.decidedBy).toBe(actorId);
    expect(res.body.item.decidedAt).toBeTruthy();

    const partnerRowAfter = await findMissingById(partnerRow!.id);
    expect(partnerRowAfter!.status).toBe("found");
    expect(partnerRowAfter!.resolutionNote).toBe("Confirmado por el socio");

    // El LOCAL, vinculado en el MISMO cluster confirmado, queda INTOCADO:
    // confirmar una señal aplica SOLO al registro que la señal identifica.
    const localRowAfter = await findMissingById(localId);
    expect(localRowAfter!.status).toBe("active");

    const auditRows = await db
      .getDb()
      .select()
      .from(db.schema.auditLog)
      .where(
        and(eq(db.schema.auditLog.action, "signal.confirm"), eq(db.schema.auditLog.targetId, signalId)),
      );
    expect(auditRows.length).toBeGreaterThan(0);
  });
});

describe("POST /:signalId/decision — descartar", () => {
  it("sin nota -> 400; con nota -> 'dismissed', el registro fuente NO se toca", async () => {
    const { token: authToken } = await makeUserWithCaps(["person:review", "person:search"]);
    const t = token();
    const source = `partner:demo-dismiss-${t}@test.local`;
    const externalId = `DEMO-dismiss-${t}`;
    await missingService.upsertExternalMissingBatch([
      { externalId, source, name: `DEMO Descarte ${t}`, status: "active" },
    ]);
    await missingService.upsertExternalMissingBatch([
      { externalId, source, name: `DEMO Descarte ${t}`, status: "found", resolutionNote: "Reclamo del socio" },
    ]);
    const row = await findMissingBySourceAndExternalId(source, externalId);
    const prn = await personRecords.ensurePrn("missing_report", row!.id);
    const pending = await pendingSignalsFor(prn!);
    expect(pending).toHaveLength(1);
    const signalId = pending[0]!.id;

    const noNote = await request(app)
      .post(`${BASE}/${signalId}/decision`)
      .set("Authorization", `Bearer ${authToken}`)
      .send({ decision: "descartar" });
    expect(noNote.status).toBe(400);

    const withNote = await request(app)
      .post(`${BASE}/${signalId}/decision`)
      .set("Authorization", `Bearer ${authToken}`)
      .send({ decision: "descartar", note: "Ruido del feed, sin evidencia real." });
    expect(withNote.status).toBe(200);
    expect(withNote.body.item.status).toBe("dismissed");

    const rowAfter = await findMissingById(row!.id);
    expect(rowAfter!.status).toBe("active");
  });
});

describe("POST /:signalId/decision — concurrencia", () => {
  it("dos revisores deciden la MISMA señal concurrentemente -> exactamente un 200, el otro 409", async () => {
    const [{ token: tokenA }, { token: tokenB }] = await Promise.all([
      makeUserWithCaps(["person:review"]),
      makeUserWithCaps(["person:review"]),
    ]);
    const t = token();
    const source = `partner:demo-race-${t}@test.local`;
    const externalId = `DEMO-race-${t}`;
    await missingService.upsertExternalMissingBatch([
      { externalId, source, name: `DEMO Race ${t}`, status: "active" },
    ]);
    await missingService.upsertExternalMissingBatch([
      { externalId, source, name: `DEMO Race ${t}`, status: "found" },
    ]);
    const row = await findMissingBySourceAndExternalId(source, externalId);
    const prn = await personRecords.ensurePrn("missing_report", row!.id);
    const pending = await pendingSignalsFor(prn!);
    const signalId = pending[0]!.id;

    const [r1, r2] = await Promise.allSettled([
      request(app).post(`${BASE}/${signalId}/decision`).set("Authorization", `Bearer ${tokenA}`).send({ decision: "confirmar" }),
      request(app).post(`${BASE}/${signalId}/decision`).set("Authorization", `Bearer ${tokenB}`).send({ decision: "confirmar" }),
    ]);
    const statuses = [r1, r2].map((r) => (r.status === "fulfilled" ? r.value.status : -1));
    expect(statuses.filter((s) => s === 200)).toHaveLength(1);
    expect(statuses.filter((s) => s === 409)).toHaveLength(1);
  });

  it("mismo revisor repite la misma decisión -> 200 idempotente; otro revisor -> 409", async () => {
    const { token: tokenA } = await makeUserWithCaps(["person:review"]);
    const { token: tokenB } = await makeUserWithCaps(["person:review"]);
    const t = token();
    const source = `partner:demo-replay-${t}@test.local`;
    const externalId = `DEMO-replay-${t}`;
    await missingService.upsertExternalMissingBatch([
      { externalId, source, name: `DEMO Replay ${t}`, status: "active" },
    ]);
    await missingService.upsertExternalMissingBatch([
      { externalId, source, name: `DEMO Replay ${t}`, status: "found" },
    ]);
    const row = await findMissingBySourceAndExternalId(source, externalId);
    const prn = await personRecords.ensurePrn("missing_report", row!.id);
    const pending = await pendingSignalsFor(prn!);
    const signalId = pending[0]!.id;

    const first = await request(app).post(`${BASE}/${signalId}/decision`).set("Authorization", `Bearer ${tokenA}`).send({ decision: "confirmar" });
    expect(first.status).toBe(200);
    expect(first.body.idempotentReplay).toBe(false);

    const replay = await request(app).post(`${BASE}/${signalId}/decision`).set("Authorization", `Bearer ${tokenA}`).send({ decision: "confirmar" });
    expect(replay.status).toBe(200);
    expect(replay.body.idempotentReplay).toBe(true);

    const other = await request(app).post(`${BASE}/${signalId}/decision`).set("Authorization", `Bearer ${tokenB}`).send({ decision: "confirmar" });
    expect(other.status).toBe(409);
  });
});

describe("confirmar sobre una transición YA aplicada a mano -> no-op idempotente", () => {
  it("el registro ya estaba 'found' (marcado a mano) cuando se confirma la señal -> markMissingFound no encuentra fila 'active', no lanza; la señal igual queda 'confirmed'", async () => {
    const { token: authToken, id: actorId } = await makeUserWithCaps(["person:review"]);
    const t = token();
    const source = `partner:demo-manual-first-${t}@test.local`;
    const externalId = `DEMO-manual-first-${t}`;
    await missingService.upsertExternalMissingBatch([
      { externalId, source, name: `DEMO Manual First ${t}`, status: "active" },
    ]);
    await missingService.upsertExternalMissingBatch([
      { externalId, source, name: `DEMO Manual First ${t}`, status: "found", resolutionNote: "Reclamo del socio" },
    ]);
    const row = await findMissingBySourceAndExternalId(source, externalId);
    const prn = await personRecords.ensurePrn("missing_report", row!.id);
    const pending = await pendingSignalsFor(prn!);
    const signalId = pending[0]!.id;

    // Un staff marca el registro como encontrado A MANO (camino normal),
    // ANTES de que la señal se confirme.
    const manual = await missingService.markMissingFound(
      row!.id,
      "Confirmado por teléfono con la familia.",
      null,
    );
    expect(manual).toBeTruthy();
    expect(manual!.status).toBe("found");

    const res = await request(app)
      .post(`${BASE}/${signalId}/decision`)
      .set("Authorization", `Bearer ${authToken}`)
      .send({ decision: "confirmar" });
    expect(res.status).toBe(200);
    expect(res.body.item.status).toBe("confirmed");
    expect(res.body.item.decidedBy).toBe(actorId);

    const rowAfter = await findMissingById(row!.id);
    expect(rowAfter!.status).toBe("found");
    // markMissingFound (dentro de applyClaimedStatus) no encontró
    // WHERE status='active' -> no-op: la nota puesta A MANO no se pisa.
    expect(rowAfter!.resolutionNote).toBe("Confirmado por teléfono con la familia.");
  });
});

describe("GET / — cola de señales pendientes", () => {
  it("lista la señal recién creada con record display fields + claimed vs stored status", async () => {
    const { token: authToken } = await makeUserWithCaps(["person:search"]);
    const t = token();
    const source = `partner:demo-list-${t}@test.local`;
    const externalId = `DEMO-list-${t}`;
    await missingService.upsertExternalMissingBatch([
      { externalId, source, name: `DEMO Lista ${t}`, status: "active" },
    ]);
    await missingService.upsertExternalMissingBatch([
      { externalId, source, name: `DEMO Lista ${t}`, status: "found", resolutionNote: "Reclamo del socio" },
    ]);
    const row = await findMissingBySourceAndExternalId(source, externalId);
    const prn = await personRecords.ensurePrn("missing_report", row!.id);

    type ListedSignal = {
      id: string;
      createdAt: number;
      prn: string;
      claimedStatus: string;
      storedStatus: string | null;
      source: string;
      record: { name: string; recordType: string } | null;
    };
    let after: string | undefined;
    let item: ListedSignal | undefined;
    for (let page = 0; page < 50 && !item; page += 1) {
      const res = await request(app)
        .get(BASE)
        .query({ limit: 200, ...(after ? { after } : {}) })
        .set("Authorization", `Bearer ${authToken}`);
      expect(res.status).toBe(200);
      const items = res.body.items as ListedSignal[];
      item = items.find((row) => row.prn === prn);
      if (item || items.length === 0) break;
      const last = items[items.length - 1];
      if (!last) break;
      after = `${last.createdAt}_${last.id}`;
    }
    expect(item).toBeTruthy();
    expect(item).toMatchObject({ claimedStatus: "found", storedStatus: "active", source });
    expect(item!.record).toMatchObject({ name: `DEMO Lista ${t}`, recordType: "missing_report" });
  });
});

describe("matriz de capacidades — record-signals", () => {
  it("person:search puede leer la lista; decidir con solo person:search -> 403; sin auth -> 401", async () => {
    const { token: searchOnly } = await makeUserWithCaps(["person:search"]);
    const listRes = await request(app).get(BASE).set("Authorization", `Bearer ${searchOnly}`);
    expect(listRes.status).toBe(200);

    const decideRes = await request(app)
      .post(`${BASE}/${randomUUID()}/decision`)
      .set("Authorization", `Bearer ${searchOnly}`)
      .send({ decision: "confirmar" });
    expect(decideRes.status).toBe(403);

    const anonRes = await request(app).get(BASE);
    expect(anonRes.status).toBe(401);
  });

  it("person:review puede decidir pero no listar (sin person:search) -> 403 en GET", async () => {
    const { token: reviewOnly } = await makeUserWithCaps(["person:review"]);
    const listRes = await request(app).get(BASE).set("Authorization", `Bearer ${reviewOnly}`);
    expect(listRes.status).toBe(403);
  });
});
