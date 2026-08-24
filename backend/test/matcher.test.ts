/**
 * Matcher determinista (U8) — integración: generación de candidatos por
 * `document_hash` y por nombre+edad normalizados, upsert de `person_links`
 * honrando KTD4/KTD5 (inmutabilidad de `confirmed`, re-propuesta condicional
 * de `rejected`/`unsure`), e idempotencia de `consumeMatcherBatch` ante
 * entrega duplicada.
 *
 * Requiere el stack local arriba (docker compose up): DATABASE_URL. PII
 * sintética: nombres DEMO, nunca datos reales; `document_hash` aquí es un
 * string de prueba (`hash-...`) — este módulo nunca calcula el HMAC real, solo
 * compara la columna, así que un string de prueba ejercita la misma lógica.
 *
 * Cada nombre sembrado lleva un token aleatorio (8 hex) para que un match por
 * nombre+edad NUNCA cruce accidentalmente con una fila de otro test o de otro
 * archivo — la DB local se comparte entre TODOS los archivos de test (ver
 * `test/helpers.ts` / `test/person-records.test.ts`: nada se limpia entre
 * corridas).
 */
import { randomUUID } from "crypto";
import { and, eq, or } from "drizzle-orm";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { testTenantOwnership } from "./helpers";
import { colombiaTenantScope } from "@/lib/colombia-tenant";

let db: typeof import("@/db");
let personRecords: typeof import("@/services/person-records");
let matcher: typeof import("@/services/matcher");
let queueConsumer: typeof import("@/lib/queue-consumer");
let missingService: typeof import("@/services/missing");
let patientsService: typeof import("@/services/patients");

beforeAll(async () => {
  db = await import("@/db");
  personRecords = await import("@/services/person-records");
  matcher = await import("@/services/matcher");
  queueConsumer = await import("@/lib/queue-consumer");
  missingService = await import("@/services/missing");
  patientsService = await import("@/services/patients");
});

afterEach(() => {
  vi.restoreAllMocks();
});

// --------------------------------------------------------------- seeding ---

function token(): string {
  return randomUUID().slice(0, 8);
}

async function makeHospital(): Promise<string> {
  const id = randomUUID();
  await db.getDb().insert(db.schema.hospitals).values({
    id,
    name: `DEMO Hospital Matcher ${id.slice(0, 8)}`,
    createdAt: Date.now(),
      ...testTenantOwnership(),
    });
  return id;
}

async function seedMissing(input: {
  name: string;
  age?: number | null;
  documentHash?: string | null;
}): Promise<string> {
  const id = randomUUID();
  await db.getDb().insert(db.schema.missingPersons).values({
    id,
    name: input.name,
    age: input.age ?? null,
    documentHash: input.documentHash ?? null,
    createdAt: Date.now(),
      ...testTenantOwnership(),
    });
  return id;
}

async function seedPatient(input: {
  hospitalId: string;
  name: string;
  age?: number | null;
  documentHash?: string | null;
}): Promise<string> {
  const id = randomUUID();
  const now = Date.now();
  await db.getDb().insert(db.schema.hospitalPatients).values({
    id,
    hospitalId: input.hospitalId,
    name: input.name,
    age: input.age ?? null,
    documentHash: input.documentHash ?? null,
    admittedAt: now,
    updatedAt: now,
      ...testTenantOwnership(),
    });
  return id;
}

/** Estampa (o lee) el PRN de un registro fuente ya sembrado. */
async function prnFor(recordType: string, recordId: string): Promise<string> {
  const prn = await personRecords.ensurePrn(recordType, recordId);
  if (!prn) throw new Error(`no se pudo estampar PRN de prueba (${recordType}/${recordId})`);
  return prn;
}

async function linkRowFor(prnX: string, prnY: string) {
  const [a, b] = matcher.orderPair(prnX, prnY);
  const rows = await db
    .getDb()
    .select()
    .from(db.schema.personLinks)
    .where(and(eq(db.schema.personLinks.prnA, a), eq(db.schema.personLinks.prnB, b)));
  return rows[0] ?? null;
}

/** Todas las filas de person_links que tocan `prn` (para asertar "cero propuestas"). */
async function linkRowsTouching(prn: string) {
  return db
    .getDb()
    .select()
    .from(db.schema.personLinks)
    .where(or(eq(db.schema.personLinks.prnA, prn), eq(db.schema.personLinks.prnB, prn)));
}

/** Siembra una fila `person_links` PRE-EXISTENTE (simula una decisión humana
 *  o una propuesta previa) para probar las reglas de inmutabilidad de KTD4/KTD5. */
async function seedLink(
  prnX: string,
  prnY: string,
  overrides: {
    status: "proposed" | "confirmed" | "rejected" | "unsure";
    evidenceClass: "document_hash_exact" | "name_age_exact";
    score?: number | null;
    evidence?: Record<string, string>;
  },
): Promise<void> {
  const [a, b] = matcher.orderPair(prnX, prnY);
  await db.getDb().insert(db.schema.personLinks).values({
    id: randomUUID(),
    prnA: a,
    prnB: b,
    status: overrides.status,
    score: overrides.score ?? null,
    evidence: overrides.evidence ?? matcher.buildEvidence(overrides.evidenceClass),
    evidenceClass: overrides.evidenceClass,
    method: "manual",
    matcherVersion: null,
    proposedAt: Date.now(),
      ...testTenantOwnership(),
    });
}

interface FakeMessage {
  id: string;
  body: unknown;
  attempts: number;
  acked: boolean;
  retried: boolean;
  ack(): void;
  retry(): void;
}

function fakeMessage(id: string, body: unknown): FakeMessage {
  const message: FakeMessage = {
    id,
    body,
    attempts: 1,
    acked: false,
    retried: false,
    ack() {
      message.acked = true;
    },
    retry() {
      message.retried = true;
    },
  };
  return message;
}

// ------------------------------------------------------------------ tests ---

describe("buildEvidence — invariante de tokens (R11)", () => {
  it("document_hash_exact -> {documento:'exact'}; name_age_exact -> {nombre:'exact', edad:'exact'}", () => {
    expect(matcher.buildEvidence("document_hash_exact")).toEqual({ documento: "exact" });
    expect(matcher.buildEvidence("name_age_exact")).toEqual({ nombre: "exact", edad: "exact" });
  });

  it("los valores de evidence son SIEMPRE el token 'exact' — nunca un dato crudo", () => {
    for (const cls of ["document_hash_exact", "name_age_exact"] as const) {
      const evidence = matcher.buildEvidence(cls);
      for (const [key, value] of Object.entries(evidence)) {
        expect(value).toBe("exact");
        expect(/\d/.test(value)).toBe(false); // ningún dígito de cédula/edad cruda
        expect(key).toMatch(/^(documento|nombre|edad)$/);
      }
    }
  });
});

describe("orderPair", () => {
  it("ordena el par para que prnA < prnB sin importar el orden de entrada", () => {
    expect(matcher.orderPair("TC-BBBBBBBBB", "TC-AAAAAAAAA")).toEqual([
      "TC-AAAAAAAAA",
      "TC-BBBBBBBBB",
    ]);
    expect(matcher.orderPair("TC-AAAAAAAAA", "TC-BBBBBBBBB")).toEqual([
      "TC-AAAAAAAAA",
      "TC-BBBBBBBBB",
    ]);
  });
});

describe("matcher — document_hash_exact", () => {
  it("un reporte y un paciente con el mismo document_hash producen UNA propuesta document_hash_exact", async () => {
    const hospitalId = await makeHospital();
    const t = token();
    const hash = `hash-doc-${t}`;
    const missingId = await seedMissing({ name: `DEMO Hash Missing ${t}`, documentHash: hash });
    const patientId = await seedPatient({
      hospitalId,
      name: `DEMO Hash Patient ${t}`,
      documentHash: hash,
    });
    const missingPrn = await prnFor("missing_report", missingId);
    const patientPrn = await prnFor("hospital_patient", patientId);

    await matcher.processMatcherMessage({ prn: missingPrn });

    const row = await linkRowFor(missingPrn, patientPrn);
    expect(row).not.toBeNull();
    expect(row!.evidenceClass).toBe("document_hash_exact");
    expect(row!.status).toBe("proposed");
    expect(row!.method).toBe("deterministic");
    expect(row!.matcherVersion).toBe("det-1");
    expect(row!.prnA < row!.prnB).toBe(true);
    expect(row!.evidence).toEqual({ documento: "exact" });

    // Invariante: el hash de prueba y los nombres DEMO nunca aparecen en evidence.
    const serialized = JSON.stringify(row!.evidence);
    expect(serialized).not.toContain(hash);
    expect(serialized).not.toContain(t);

    // Solo UNA fila para este par (no una por dirección, no duplicada).
    const rows = await linkRowsTouching(missingPrn);
    expect(rows).toHaveLength(1);
  });
});

describe("matcher — name_age_exact", () => {
  it("dos reportes con el mismo nombre normalizado + misma edad producen missing↔missing name_age_exact", async () => {
    const t = token();
    // "José Pérez" (con acentos, espacio simple) vs "jose  perez" (sin
    // acentos, doble espacio) — deben normalizar al MISMO valor (KTD10:
    // minúsculas + sin acentos + espacios colapsados).
    const idA = await seedMissing({ name: `José  Pérez Demo${t}`, age: 34 });
    const idB = await seedMissing({ name: `jose perez demo${t}`, age: 34 });
    const prnA = await prnFor("missing_report", idA);
    const prnB = await prnFor("missing_report", idB);

    await matcher.processMatcherMessage({ prn: prnA });

    const row = await linkRowFor(prnA, prnB);
    expect(row).not.toBeNull();
    expect(row!.evidenceClass).toBe("name_age_exact");
    expect(row!.status).toBe("proposed");
    expect(row!.evidence).toEqual({ nombre: "exact", edad: "exact" });
  });

  it("mismo nombre, edad distinta o nula → sin propuesta", async () => {
    const t = token();
    const name = `DEMO Sin Match ${t}`;
    const idA = await seedMissing({ name, age: 20 });
    await seedMissing({ name, age: 21 });
    await seedMissing({ name, age: null });
    const prnA = await prnFor("missing_report", idA);

    await matcher.processMatcherMessage({ prn: prnA });

    expect(await linkRowsTouching(prnA)).toEqual([]);
  });

  it("registro sin documento y sin coincidencia de nombre → cero propuestas, sin error", async () => {
    const t = token();
    const id = await seedMissing({ name: `DEMO Unico Sin Documento ${t}`, age: 99 });
    const prn = await prnFor("missing_report", id);

    await expect(matcher.processMatcherMessage({ prn })).resolves.toBeUndefined();
    expect(await linkRowsTouching(prn)).toEqual([]);
  });
});

describe("matcher — KTD5: inmutabilidad de confirmed/rejected", () => {
  it("un link confirmado queda byte-idéntico (el matcher nunca lo toca)", async () => {
    const t = token();
    const name = `DEMO Confirmado ${t}`;
    const idA = await seedMissing({ name, age: 40 });
    const idB = await seedMissing({ name, age: 40 });
    const prnA = await prnFor("missing_report", idA);
    const prnB = await prnFor("missing_report", idB);

    await seedLink(prnA, prnB, {
      status: "confirmed",
      evidenceClass: "name_age_exact",
      score: 0.5,
    });
    const before = await linkRowFor(prnA, prnB);
    expect(before).not.toBeNull();

    await matcher.processMatcherMessage({ prn: prnA });

    const after = await linkRowFor(prnA, prnB);
    expect(after).toEqual(before);
  });

  it("rechazado con document_hash_exact NUNCA se re-propone (no hay clase más fuerte)", async () => {
    const hospitalId = await makeHospital();
    const t = token();
    const hash = `hash-noreopen-${t}`;
    const missingId = await seedMissing({ name: `DEMO NoReopen ${t}`, documentHash: hash });
    const patientId = await seedPatient({ hospitalId, name: `DEMO NoReopen ${t}`, documentHash: hash });
    const missingPrn = await prnFor("missing_report", missingId);
    const patientPrn = await prnFor("hospital_patient", patientId);

    await seedLink(missingPrn, patientPrn, {
      status: "rejected",
      evidenceClass: "document_hash_exact",
      score: 1,
    });
    const before = await linkRowFor(missingPrn, patientPrn);

    await matcher.processMatcherMessage({ prn: missingPrn });

    const after = await linkRowFor(missingPrn, patientPrn);
    expect(after).toEqual(before);
  });
});

describe("matcher — KTD4: re-propuesta solo por clase estrictamente más fuerte", () => {
  it("rechazado con name_age_exact se re-propone cuando document_hash_exact aparece después", async () => {
    const hospitalId = await makeHospital();
    const t = token();
    const hash = `hash-reopen-${t}`;
    const name = `DEMO Reopen ${t}`;
    const missingId = await seedMissing({ name, age: 50, documentHash: hash });
    const patientId = await seedPatient({ hospitalId, name, age: 50, documentHash: hash });
    const missingPrn = await prnFor("missing_report", missingId);
    const patientPrn = await prnFor("hospital_patient", patientId);

    await seedLink(missingPrn, patientPrn, {
      status: "rejected",
      evidenceClass: "name_age_exact",
      score: 0.75,
    });

    await matcher.processMatcherMessage({ prn: missingPrn });

    const row = await linkRowFor(missingPrn, patientPrn);
    expect(row!.status).toBe("proposed");
    expect(row!.evidenceClass).toBe("document_hash_exact");
    expect(row!.evidence).toEqual({ documento: "exact" });
  });
});

describe("matcher — KTD4: refresco condicional de 'unsure'", () => {
  it("re-sweep de la MISMA clase refresca score/evidence y el status se queda en unsure", async () => {
    const t = token();
    const name = `DEMO Unsure ${t}`;
    const idA = await seedMissing({ name, age: 60 });
    const idB = await seedMissing({ name, age: 60 });
    const prnA = await prnFor("missing_report", idA);
    const prnB = await prnFor("missing_report", idB);

    await seedLink(prnA, prnB, { status: "unsure", evidenceClass: "name_age_exact", score: 0.1 });
    const before = await linkRowFor(prnA, prnB);

    await matcher.processMatcherMessage({ prn: prnA });

    const after = await linkRowFor(prnA, prnB);
    expect(after!.status).toBe("unsure");
    expect(after!.score).not.toBe(before!.score); // refrescado al score fijo de la clase
    expect(after!.proposedAt).toBeGreaterThanOrEqual(before!.proposedAt);
  });

  it("una clase más fuerte sobre 'unsure' lo transiciona a 'proposed'", async () => {
    const hospitalId = await makeHospital();
    const t = token();
    const hash = `hash-unsure-upgrade-${t}`;
    const name = `DEMO UnsureUpgrade ${t}`;
    const missingId = await seedMissing({ name, documentHash: hash });
    const patientId = await seedPatient({ hospitalId, name, documentHash: hash });
    const missingPrn = await prnFor("missing_report", missingId);
    const patientPrn = await prnFor("hospital_patient", patientId);

    await seedLink(missingPrn, patientPrn, {
      status: "unsure",
      evidenceClass: "name_age_exact",
      score: 0.1,
    });

    await matcher.processMatcherMessage({ prn: missingPrn });

    const row = await linkRowFor(missingPrn, patientPrn);
    expect(row!.status).toBe("proposed");
    expect(row!.evidenceClass).toBe("document_hash_exact");
  });
});

describe("matcher — idempotencia del consumidor (entrega al-menos-una-vez)", () => {
  it("el mismo mensaje consumido dos veces deja UNA sola fila en person_links", async () => {
    const hospitalId = await makeHospital();
    const t = token();
    const hash = `hash-twice-${t}`;
    const name = `DEMO Twice ${t}`;
    const missingId = await seedMissing({ name, documentHash: hash });
    const patientId = await seedPatient({ hospitalId, name, documentHash: hash });
    const missingPrn = await prnFor("missing_report", missingId);
    const patientPrn = await prnFor("hospital_patient", patientId);

    const run = vi.fn((job: { prn: string }) => matcher.processMatcherMessage(job));

    await queueConsumer.consumeMatcherBatch(
      { queue: "terremotocolombia-matcher", messages: [fakeMessage("dup-1", { prn: missingPrn })] },
      { run },
    );
    await queueConsumer.consumeMatcherBatch(
      { queue: "terremotocolombia-matcher", messages: [fakeMessage("dup-1", { prn: missingPrn })] },
      { run },
    );

    expect(run).toHaveBeenCalledTimes(2);

    const rows = await linkRowsTouching(missingPrn);
    const relevant = rows.filter((r) => r.prnA === patientPrn || r.prnB === patientPrn);
    expect(relevant).toHaveLength(1);
  });
});

describe("matcher — el sweep se dispara en creación (finding #6, AE2/U8)", () => {
  // addMissing/createPatient llaman a ensurePrn best-effort y, cuando el PRN
  // se estampa ahí mismo, a enqueueMatcherSweep([prn]) — si no, el registro
  // recién creado nunca aparece en listUnstamped (ya tiene PRN) y el cron de
  // reconciliación tampoco lo barre, así que un match contra un registro
  // existente no produce propuesta hasta el próximo cambio disparador.

  it("addMissing encola un sweep con el PRN del reporte recién creado", async () => {
    personRecords.takeMatcherSweepCalls(); // drena residuo de otros tests de este archivo
    const t = token();

    const created = await missingService.addMissing(
      { name: `DEMO Sweep Missing ${t}` },
      colombiaTenantScope(),
    );
    // ensurePrn es idempotente: la segunda llamada solo LEE el PRN ya
    // estampado por addMissing, sin volver a encolar un sweep.
    const prn = await personRecords.ensurePrn("missing_report", created.id);
    expect(prn).not.toBeNull();

    const sweptPrns = personRecords.takeMatcherSweepCalls().flat();
    expect(sweptPrns).toContain(prn);
  });

  it("createPatient encola un sweep con el PRN del paciente recién creado", async () => {
    personRecords.takeMatcherSweepCalls(); // drena residuo de otros tests de este archivo
    const hospitalId = await makeHospital();
    const t = token();

    const created = await patientsService.createPatient({
      hospitalId,
      name: `DEMO Sweep Patient ${t}`,
    }, colombiaTenantScope());
    const prn = await personRecords.ensurePrn("hospital_patient", created.id);
    expect(prn).not.toBeNull();

    const sweptPrns = personRecords.takeMatcherSweepCalls().flat();
    expect(sweptPrns).toContain(prn);
  });
});
