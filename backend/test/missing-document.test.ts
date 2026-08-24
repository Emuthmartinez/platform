/**
 * Captura de cédula por staff en reportes de desaparecidos (U12) — el join key
 * determinista que dispara el matcher (U8): `tipo_documento` + `document_hash`
 * (HMAC, MISMA clave/normalización que `hospital_patients` — vía
 * `patient-import-logic.ts`), NUNCA el número crudo. A diferencia de
 * `patients.resource.ts`, SIN 409 por colisión (KTD9, a propósito): dos
 * reportes con la misma cédula son señal de duplicado para el matcher, no un
 * conflicto que bloquear — AE2 (missing↔patient) es exactamente ese cruce.
 *
 * Requiere el stack local arriba (docker compose up): DATABASE_URL + VALKEY_URL.
 * PII sintética: nombres/hospitales demo y cédulas = strings de dígitos
 * inventados en el test, nunca datos reales.
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
let matcherSvc: typeof import("@/services/matcher");
let importLogic: typeof import("@/services/patient-import-logic");

beforeAll(async () => {
  app = (await import("@/server")).app;
  db = await import("@/db");
  personRecords = await import("@/services/person-records");
  matcherSvc = await import("@/services/matcher");
  importLogic = await import("@/services/patient-import-logic");
});

const CAPS = ["missing:read", "missing:edit"];

/** Cédula SINTÉTICA de 10 dígitos (nunca una real): timestamp + aleatorio. */
function syntheticDigits(): string {
  return String(Math.floor(1_000_000_000 + Math.random() * 8_999_999_999));
}

async function seedMissingReport(name: string): Promise<string> {
  const id = randomUUID();
  await db.getDb().insert(db.schema.missingPersons).values({ id, name, createdAt: Date.now(), ...testTenantOwnership() });
  return id;
}

async function seedHospital(name: string): Promise<string> {
  const id = randomUUID();
  await db.getDb().insert(db.schema.hospitals).values({ id, name, createdAt: Date.now(), ...testTenantOwnership() });
  return id;
}

async function seedPatientWithHash(
  hospitalId: string,
  name: string,
  documentHash: string,
): Promise<string> {
  const id = randomUUID();
  const now = Date.now();
  await db.getDb().insert(db.schema.hospitalPatients).values({
    id,
    hospitalId,
    name,
    documentHash,
    admittedAt: now,
    updatedAt: now,
      ...testTenantOwnership(),
    });
  return id;
}

/** Mismo HMAC que calcula missing.resource.ts (misma clave que patients). */
function expectedHash(rawDigits: string): string {
  const secret = process.env.PATIENT_DOCUMENT_HASH_SECRET!;
  const digits = importLogic.documentDigits(rawDigits)!;
  return importLogic.hashDocumentDigits(digits, secret);
}

async function linkRowFor(prnX: string, prnY: string) {
  const [a, b] = matcherSvc.orderPair(prnX, prnY);
  const rows = await db
    .getDb()
    .select()
    .from(db.schema.personLinks)
    .where(and(eq(db.schema.personLinks.prnA, a), eq(db.schema.personLinks.prnB, b)));
  return rows[0] ?? null;
}

describe("PATCH /api/public/missing/:id — captura de cédula (U12)", () => {
  it("guarda tipo_documento + hash; el número crudo NO aparece en la fila ni en la respuesta", async () => {
    const { token } = await makeUserWithCaps(CAPS);
    const id = await seedMissingReport(`DEMO Cedula ${randomUUID().slice(0, 8)}`);
    const digits = syntheticDigits();
    const raw = `${digits.slice(0, 2)}.${digits.slice(2, 5)}.${digits.slice(5)}-1`; // puntos/guion, como escribe el staff

    const res = await request(app)
      .patch(`/api/public/missing/${id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ tipoDocumento: "CC", documentId: raw });

    expect(res.status).toBe(200);
    expect(res.body.item.hasDocument).toBe(true);
    expect(res.body.item.tipoDocumento).toBe("CC");
    // El crudo (con o sin puntos) no debe asomar en NINGUNA parte de la respuesta.
    const serialized = JSON.stringify(res.body);
    expect(serialized).not.toContain(digits);
    expect(serialized).not.toContain(raw);

    const row = await db
      .getDb()
      .select({
        tipoDocumento: db.schema.missingPersons.tipoDocumento,
        documentHash: db.schema.missingPersons.documentHash,
      })
      .from(db.schema.missingPersons)
      .where(eq(db.schema.missingPersons.id, id));
    expect(row[0]?.tipoDocumento).toBe("CC");
    expect(row[0]?.documentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row[0]?.documentHash).toBe(expectedHash(raw));
    // La huella tampoco puede contener el número crudo como substring.
    expect(row[0]!.documentHash!).not.toContain(digits);
  });

  it("sin_documento sin documentId guarda; documento <4 dígitos y tipoDocumento inválido → 400", async () => {
    const { token } = await makeUserWithCaps(CAPS);
    const id = await seedMissingReport(`DEMO SinDoc ${randomUUID().slice(0, 8)}`);

    const ok = await request(app)
      .patch(`/api/public/missing/${id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ tipoDocumento: "sin_documento" });
    expect(ok.status).toBe(200);
    expect(ok.body.item.tipoDocumento).toBe("sin_documento");
    expect(ok.body.item.hasDocument).toBe(false);

    const shortDoc = await request(app)
      .patch(`/api/public/missing/${id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ documentId: "12" }); // 2 dígitos, < 4 exigidos
    expect(shortDoc.status).toBe(400);

    const badTipo = await request(app)
      .patch(`/api/public/missing/${id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ tipoDocumento: "PASAPORTE" }); // no está en el catálogo cerrado
    expect(badTipo.status).toBe(400);
  });

  it("PATCH con cambio de documento dispara ensurePrn + enqueueMatcherSweep", async () => {
    const { token } = await makeUserWithCaps(CAPS);
    const id = await seedMissingReport(`DEMO Sweep ${randomUUID().slice(0, 8)}`);
    personRecords.takeMatcherSweepCalls(); // drena lo acumulado por corridas previas

    const res = await request(app)
      .patch(`/api/public/missing/${id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ tipoDocumento: "CC", documentId: syntheticDigits() });
    expect(res.status).toBe(200);

    const prn = await personRecords.ensurePrn("missing_report", id);
    expect(prn).toBeTruthy();
    const calls = personRecords.takeMatcherSweepCalls();
    expect(calls.some((batch) => batch.includes(prn!))).toBe(true);
  });
});

describe("matcher — document_hash_exact tras la captura de cédula (U12/AE2)", () => {
  it("misma cédula en DOS reportes → ambos se guardan (sin 409) y el matcher propone missing↔missing", async () => {
    const { token } = await makeUserWithCaps(CAPS);
    const digits = syntheticDigits();
    const idA = await seedMissingReport(`DEMO Duplicado A ${randomUUID().slice(0, 8)}`);
    const idB = await seedMissingReport(`DEMO Duplicado B ${randomUUID().slice(0, 8)}`);

    const resA = await request(app)
      .patch(`/api/public/missing/${idA}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ tipoDocumento: "CC", documentId: digits });
    const resB = await request(app)
      .patch(`/api/public/missing/${idB}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ tipoDocumento: "CC", documentId: digits });

    // Divergencia deliberada de patients.resource.ts (KTD9): NO hay 409 por
    // colisión de documento — dos reportes con la misma cédula son señal.
    expect(resA.status).toBe(200);
    expect(resB.status).toBe(200);

    const prnA = await personRecords.ensurePrn("missing_report", idA);
    const prnB = await personRecords.ensurePrn("missing_report", idB);
    expect(prnA).toBeTruthy();
    expect(prnB).toBeTruthy();

    await matcherSvc.processMatcherMessage({ prn: prnA! });

    const row = await linkRowFor(prnA!, prnB!);
    expect(row).not.toBeNull();
    expect(row!.evidenceClass).toBe("document_hash_exact");
    expect(row!.status).toBe("proposed");
    // Invariante R11: la evidencia nunca lleva el dígito crudo.
    expect(JSON.stringify(row!.evidence)).not.toContain(digits);
  });

  it("cédula que coincide con un paciente hospitalario existente → propuesta cruzada (AE2)", async () => {
    const { token } = await makeUserWithCaps(CAPS);
    const raw = syntheticDigits();
    const hospitalId = await seedHospital(`DEMO Hospital U12 ${randomUUID().slice(0, 8)}`);
    const patientId = await seedPatientWithHash(
      hospitalId,
      `DEMO Paciente U12 ${randomUUID().slice(0, 8)}`,
      expectedHash(raw),
    );
    const missingId = await seedMissingReport(`DEMO Reporte U12 ${randomUUID().slice(0, 8)}`);

    const res = await request(app)
      .patch(`/api/public/missing/${missingId}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ tipoDocumento: "CC", documentId: raw });
    expect(res.status).toBe(200);

    const missingPrn = await personRecords.ensurePrn("missing_report", missingId);
    const patientPrn = await personRecords.ensurePrn("hospital_patient", patientId);
    expect(missingPrn).toBeTruthy();
    expect(patientPrn).toBeTruthy();

    await matcherSvc.processMatcherMessage({ prn: missingPrn! });

    const row = await linkRowFor(missingPrn!, patientPrn!);
    expect(row).not.toBeNull();
    expect(row!.evidenceClass).toBe("document_hash_exact");
    expect(row!.status).toBe("proposed");
  });
});

describe("rutas anónimas (/api/missing) — sin filtración de documento", () => {
  it("GET /api/missing (listado/detalle público) no expone hasDocument/tipoDocumento/document_hash", async () => {
    const { token } = await makeUserWithCaps(CAPS);
    const tag = `Zdemo${Math.trunc(performance.now())}`;
    const id = await seedMissingReport(`${tag} Persona Sintetica`);
    const patched = await request(app)
      .patch(`/api/public/missing/${id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ tipoDocumento: "CC", documentId: syntheticDigits() });
    expect(patched.status).toBe(200);

    const res = await request(app).get("/api/missing").query({ q: tag });
    expect(res.status).toBe(200);
    const found = res.body.people.find((p: { id: string }) => p.id === id);
    expect(found).toBeTruthy();
    for (const key of ["hasDocument", "tipoDocumento", "tipo_documento", "documentHash", "document_hash"]) {
      expect(found).not.toHaveProperty(key);
    }
    const serialized = JSON.stringify(res.body);
    expect(serialized).not.toMatch(/document_hash|tipo_documento|hasDocument/);
  });

  it("POST /api/missing (alta anónima — el 'detalle' que devuelve) no expone hasDocument/tipoDocumento", async () => {
    const res = await request(app)
      .post("/api/missing")
      .send({ name: `Zdemo Anon ${randomUUID().slice(0, 6)}` });
    expect(res.status).toBe(201);
    expect(res.body.person).not.toHaveProperty("hasDocument");
    expect(res.body.person).not.toHaveProperty("tipoDocumento");
    const serialized = JSON.stringify(res.body);
    expect(serialized).not.toMatch(/document_hash|tipo_documento|hasDocument/);
  });
});

describe("GET /api/public/missing — camino gated expone hasDocument/tipoDocumento", () => {
  it("antes de capturar: hasDocument false / tipoDocumento null; después del PATCH: true / el tipo capturado", async () => {
    const { token } = await makeUserWithCaps(CAPS);
    const id = await seedMissingReport(`DEMO Gated ${randomUUID().slice(0, 8)}`);

    const before = await request(app)
      .get(`/api/public/missing/${id}`)
      .set("Authorization", `Bearer ${token}`);
    expect(before.status).toBe(200);
    expect(before.body.item.hasDocument).toBe(false);
    expect(before.body.item.tipoDocumento).toBeNull();

    const patched = await request(app)
      .patch(`/api/public/missing/${id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ tipoDocumento: "TI", documentId: syntheticDigits() });
    expect(patched.status).toBe(200);

    const after = await request(app)
      .get(`/api/public/missing/${id}`)
      .set("Authorization", `Bearer ${token}`);
    expect(after.status).toBe(200);
    expect(after.body.item.hasDocument).toBe(true);
    expect(after.body.item.tipoDocumento).toBe("TI");

    // El listado gated (misma DTO) también lo expone.
    const list = await request(app)
      .get("/api/public/missing")
      .set("Authorization", `Bearer ${token}`);
    expect(list.status).toBe(200);
    const row = list.body.items.find((p: { id: string }) => p.id === id);
    expect(row?.hasDocument).toBe(true);
    expect(row?.tipoDocumento).toBe("TI");
  });

  it("limpiar documentId (null) borra el hash: hasDocument pasa a false (tipoDocumento no se toca)", async () => {
    const { token } = await makeUserWithCaps(CAPS);
    const id = await seedMissingReport(`DEMO Clear ${randomUUID().slice(0, 8)}`);

    const withDoc = await request(app)
      .patch(`/api/public/missing/${id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ tipoDocumento: "CE", documentId: syntheticDigits() });
    expect(withDoc.status).toBe(200);
    expect(withDoc.body.item.hasDocument).toBe(true);

    const cleared = await request(app)
      .patch(`/api/public/missing/${id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ documentId: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.item.hasDocument).toBe(false);
    expect(cleared.body.item.tipoDocumento).toBe("CE"); // solo el documento se borró

    const row = await db
      .getDb()
      .select({ documentHash: db.schema.missingPersons.documentHash })
      .from(db.schema.missingPersons)
      .where(eq(db.schema.missingPersons.id, id));
    expect(row[0]?.documentHash).toBeNull();
  });
});

describe("capacidad — PATCH /api/public/missing/:id gateado por missing:edit", () => {
  it("anónimo (sin token) → 401", async () => {
    const id = await seedMissingReport(`DEMO Anon401 ${randomUUID().slice(0, 8)}`);
    const res = await request(app)
      .patch(`/api/public/missing/${id}`)
      .send({ tipoDocumento: "CC" });
    expect(res.status).toBe(401);
  });

  it("con missing:read pero SIN missing:edit → 403", async () => {
    const { token } = await makeUserWithCaps(["missing:read"]);
    const id = await seedMissingReport(`DEMO Solo403 ${randomUUID().slice(0, 8)}`);
    const res = await request(app)
      .patch(`/api/public/missing/${id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ tipoDocumento: "CC" });
    expect(res.status).toBe(403);
  });
});
