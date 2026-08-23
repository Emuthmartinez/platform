/**
 * Registro de PRNs (U7) — integración: `ensurePrn`, `resolvePrn`,
 * `listUnstamped`, los ganchos de creación en `missing.ts`/`patients.ts`, y el
 * cron de reconciliación `reconcilePersonRecords`.
 *
 * Requiere el stack local arriba (docker compose up): DATABASE_URL. PII
 * sintética: nombres DEMO, nunca datos reales.
 *
 * La DB local se comparte entre TODOS los archivos de test (ver
 * `test/helpers.ts`: nada se limpia entre corridas). Antes de cualquier
 * aserción sensible al conteo/paginación, se DRENA el backlog existente de
 * `person_records` con `reconcilePersonRecords` — así "cuántas filas sin PRN
 * hay" es determinista y no depende de lo que dejaron otros archivos.
 */
import { randomUUID } from "crypto";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import "./helpers";
import { generatePrn } from "@/lib/prn";
import { colombiaTenantScope } from "@/lib/colombia-tenant";

let db: typeof import("@/db");
let service: typeof import("@/services/person-records");
let missingService: typeof import("@/services/missing");
let patientsService: typeof import("@/services/patients");

/** Drena TODO el backlog actual (todas las poblaciones) hasta que una corrida
 *  no estampe nada — acota en 5 vueltas por si el backlog real fuera enorme. */
async function drainBacklog(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    const r = await service.reconcilePersonRecords({ batchSize: 500, timeBudgetMs: 20_000 });
    service.takeMatcherSweepCalls(); // no interesan las llamadas del drenaje
    if (r.stampedTotal === 0) return;
  }
}

beforeAll(async () => {
  db = await import("@/db");
  service = await import("@/services/person-records");
  missingService = await import("@/services/missing");
  patientsService = await import("@/services/patients");
  await drainBacklog();
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function seedMissingReport(): Promise<string> {
  const id = randomUUID();
  await db.getDb().insert(db.schema.missingPersons).values({
    id,
    name: `DEMO PRN Missing ${id.slice(0, 8)}`,
    createdAt: Date.now(),
  });
  return id;
}

async function seedUnidentifiedPerson(): Promise<string> {
  const id = randomUUID();
  await db.getDb().insert(db.schema.unidentifiedPersons).values({ id, createdAt: Date.now() });
  return id;
}

async function makeHospital(): Promise<string> {
  const id = randomUUID();
  await db.getDb().insert(db.schema.hospitals).values({
    id,
    name: `DEMO Hospital PRN ${id.slice(0, 8)}`,
    createdAt: Date.now(),
  });
  return id;
}

async function seedHospitalPatient(hospitalId: string): Promise<string> {
  const id = randomUUID();
  const now = Date.now();
  await db.getDb().insert(db.schema.hospitalPatients).values({
    id,
    hospitalId,
    name: `DEMO PRN Paciente ${id.slice(0, 8)}`,
    admittedAt: now,
    updatedAt: now,
  });
  return id;
}

async function registryRowFor(recordType: string, recordId: string) {
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

describe("ensurePrn", () => {
  it("es idempotente: llamarlo dos veces para el mismo registro deja UNA sola fila", async () => {
    const recordId = randomUUID();

    const prn1 = await service.ensurePrn("missing_report", recordId);
    const prn2 = await service.ensurePrn("missing_report", recordId);

    expect(prn1).not.toBeNull();
    expect(prn2).toBe(prn1);

    const row = await registryRowFor("missing_report", recordId);
    expect(row?.prn).toBe(prn1);
  });

  it("estampa registros distintos con PRNs distintos", async () => {
    const a = randomUUID();
    const b = randomUUID();
    const prnA = await service.ensurePrn("missing_report", a);
    const prnB = await service.ensurePrn("missing_report", b);
    expect(prnA).not.toBeNull();
    expect(prnB).not.toBeNull();
    expect(prnA).not.toBe(prnB);
  });
});

describe("ganchos de creación (best-effort)", () => {
  it("crear un reporte de desaparecido estampa un registro record_type=missing_report", async () => {
    const created = await missingService.addMissing(
      { name: "DEMO Persona Uno" },
      colombiaTenantScope(),
    );
    const row = await registryRowFor("missing_report", created.id);
    expect(row).not.toBeNull();
    expect(row?.prn).toMatch(/^TC-/);
  });

  it("crear un paciente estampa un registro record_type=hospital_patient", async () => {
    const hospitalId = await makeHospital();
    const created = await patientsService.createPatient({
      hospitalId,
      name: "DEMO Paciente Uno",
    }, colombiaTenantScope());
    const row = await registryRowFor("hospital_patient", created.id);
    expect(row).not.toBeNull();
    expect(row?.prn).toMatch(/^TC-/);
  });
});

describe("resolvePrn", () => {
  it("resuelve un PRN de vuelta a su registro, tolerando variantes de formato", async () => {
    const recordId = randomUUID();
    const prn = await service.ensurePrn("unidentified_person", recordId);
    expect(prn).not.toBeNull();

    const messy = prn!.toLowerCase().replace("-", "");
    const ref = await service.resolvePrn(messy);
    expect(ref).toEqual({ recordType: "unidentified_person", recordId, removedAt: null });
  });

  it("una entrada con forma inválida o un PRN bien formado pero inexistente devuelven null", async () => {
    expect(await service.resolvePrn("basura")).toBeNull();
    expect(await service.resolvePrn(generatePrn())).toBeNull();
  });
});

describe("listUnstamped", () => {
  it("pagina en orden de id, sin repetir ni saltar filas, avanzando el cursor", async () => {
    await drainBacklog(); // aísla esta prueba de lo que dejaron pruebas previas

    const seeded = [];
    for (let i = 0; i < 5; i++) seeded.push(await seedMissingReport());
    seeded.sort();

    const page1 = await service.listUnstamped("missing_report", null, 2);
    expect(page1).toEqual(seeded.slice(0, 2));

    const page2 = await service.listUnstamped(
      "missing_report",
      page1[page1.length - 1]!,
      2,
    );
    expect(page2).toEqual(seeded.slice(2, 4));

    const page3 = await service.listUnstamped(
      "missing_report",
      page2[page2.length - 1]!,
      2,
    );
    expect(page3).toEqual(seeded.slice(4, 5));

    const page4 = await service.listUnstamped(
      "missing_report",
      page3[page3.length - 1]!,
      2,
    );
    expect(page4).toEqual([]); // sin más backlog

    // Deja limpio para las pruebas siguientes.
    await drainBacklog();
  });

  it("un record_type desconocido devuelve lista vacía sin lanzar", async () => {
    expect(await service.listUnstamped("no-existe", null, 10)).toEqual([]);
  });
});

describe("reconcilePersonRecords — cron de reconciliación", () => {
  it("estampa un backlog sembrado de 50 registros repartidos en 3 poblaciones; una segunda corrida no vuelve a tocarlos", async () => {
    await drainBacklog();

    const hospitalId = await makeHospital();
    const missingIds: string[] = [];
    const patientIds: string[] = [];
    const unidentifiedIds: string[] = [];
    for (let i = 0; i < 20; i++) missingIds.push(await seedMissingReport());
    for (let i = 0; i < 20; i++) patientIds.push(await seedHospitalPatient(hospitalId));
    for (let i = 0; i < 10; i++) unidentifiedIds.push(await seedUnidentifiedPerson());

    const first = await service.reconcilePersonRecords({
      batchSize: 500,
      timeBudgetMs: 20_000,
    });

    expect(first.stampedByType.missing_report).toBe(20);
    expect(first.stampedByType.hospital_patient).toBe(20);
    expect(first.stampedByType.unidentified_person).toBe(10);
    expect(first.stampedTotal).toBe(50);
    expect(first.drainedByType.missing_report).toBe(true);
    expect(first.drainedByType.hospital_patient).toBe(true);
    expect(first.drainedByType.unidentified_person).toBe(true);

    const rows = await Promise.all([
      ...missingIds.map((id) => registryRowFor("missing_report", id)),
      ...patientIds.map((id) => registryRowFor("hospital_patient", id)),
      ...unidentifiedIds.map((id) => registryRowFor("unidentified_person", id)),
    ]);
    for (const row of rows) {
      expect(row?.prn).toMatch(/^TC-/);
    }

    // El hook de matcher sweep (seam de test, ver services/person-records.ts)
    // vio exactamente los 50 PRNs de esta corrida.
    const sweptPrns = new Set(service.takeMatcherSweepCalls().flat());
    expect(sweptPrns.size).toBe(50);
    for (const row of rows) {
      expect(sweptPrns.has(row!.prn)).toBe(true);
    }

    // Segunda corrida: nada queda pendiente, y ninguno de estos 50 PRNs se
    // vuelve a encolar (ON CONFLICT DO NOTHING los deja fuera del RETURNING).
    const second = await service.reconcilePersonRecords({
      batchSize: 500,
      timeBudgetMs: 20_000,
    });
    const secondSweptPrns = new Set(service.takeMatcherSweepCalls().flat());
    expect(second.stampedTotal).toBe(0);
    for (const row of rows) {
      expect(secondSweptPrns.has(row!.prn)).toBe(false);
    }
  });

  it("respeta el presupuesto de tiempo: corta a mitad de una población y retoma en la siguiente corrida", async () => {
    await drainBacklog();

    const ids: string[] = [];
    for (let i = 0; i < 3; i++) ids.push(await seedMissingReport());
    ids.sort();

    // Reloj simulado (mismo idioma que test/acopio.test.ts): dentro de
    // reconcilePersonRecords, Date.now() se llama SOLO para `startedAt` y en
    // cada comprobación del `while` (listUnstamped/stampBatch no llaman al
    // reloj — reciben `startedAt` ya calculado). Las dos primeras lecturas
    // devuelven el instante real (startedAt + primera comprobación, dentro
    // del presupuesto); de ahí en más, un instante muy por delante, para que
    // la SEGUNDA comprobación del while (tras procesar un lote) exceda el
    // presupuesto y corte el bucle.
    const now = Date.now();
    let calls = 0;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => {
      calls += 1;
      return calls <= 2 ? now : now + 100_000;
    });

    const result = await service.reconcilePersonRecords({
      batchSize: 1,
      timeBudgetMs: 1_000,
    });
    clock.mockRestore();

    expect(result.stampedByType.missing_report).toBe(1); // un solo lote
    expect(result.drainedByType.missing_report).toBe(false); // quedó backlog
    service.takeMatcherSweepCalls();

    // Reanudación con reloj real: no hace falta persistir un cursor entre
    // corridas — las filas ya estampadas quedan fuera del LEFT JOIN de
    // listUnstamped, así que la corrida siguiente retoma justo donde la
    // anterior cortó.
    const resume = await service.reconcilePersonRecords({
      batchSize: 500,
      timeBudgetMs: 20_000,
    });
    expect(resume.stampedByType.missing_report).toBe(2);
    service.takeMatcherSweepCalls();

    for (const id of ids) {
      const row = await registryRowFor("missing_report", id);
      expect(row?.prn).toMatch(/^TC-/);
    }
  });
});

describe("runClusterInvariantChecks (KTD8)", () => {
  // Los casos de reparación (endpoint dividido, status sin decisión) viven en
  // person-links.test.ts; aquí solo el smoke: corre limpio contra el estado
  // actual de la DB compartida, que es como lo invoca el cron.
  it("corre sin lanzar sobre el estado real de la DB", async () => {
    await expect(service.runClusterInvariantChecks()).resolves.toBeUndefined();
  });
});
