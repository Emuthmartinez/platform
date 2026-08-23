// Tests del slice de voluntarios: POST /api/volunteers (validación + persistencia
// del hash de IP, nunca la IP cruda) y el mapeo a VolunteerDTO del service
// (allowlist: nunca expone ip_hash al panel admin).
//
// Sigue el patrón de needs-http.test.ts: app real de Express montada en memoria
// (supertest, sin puerto) + mock en el LÍMITE de infraestructura (aquí `@/db`,
// igual que needs-http mockea la cola) en vez de contra Postgres real — no hace
// falta el stack local para este suite. `@/db` se mockea con `importOriginal`
// para reutilizar el `schema` real (columnas Drizzle reales para que
// `desc()`/`eq()` en el service sigan funcionando) y sustituir solo `getDb()`
// por un doble en memoria.
import "./helpers";
import express from "express";
import request from "supertest";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

interface FakeVolunteerRow {
  id: string;
  name: string;
  contact: string;
  code: string;
  offer: string;
  zone: string;
  availability: string | null;
  offerTypes: string[] | null;
  digitalSkills: string[] | null;
  crisisExperience: boolean | null;
  fieldCity: string | null;
  rescueTraining: boolean | null;
  fieldRole: string | null;
  ownVehicle: boolean | null;
  source: string | null;
  status: string;
  notes: string | null;
  ipHash: string | null;
  createdAt: number;
  updatedAt: number | null;
}

const dbMocks = vi.hoisted(() => ({
  insertedRows: [] as FakeVolunteerRow[],
}));

// Doble en memoria de `getDb()`: sin Postgres real. Los métodos de la cadena
// (`from`/`where`/`orderBy`/`limit`) se ignoran (no hay filtrado real) y solo
// importan `insert().values()` (guarda la fila) y el `then` final (resuelve a
// las filas guardadas) — suficiente para ejercitar create/list/getById del
// service tal cual los usa.
vi.mock("@/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/db")>();

  function chain(rows: FakeVolunteerRow[]) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- doble mínimo de la cadena fluida de Drizzle, solo para tests
    const c: any = {
      from: () => c,
      where: () => c,
      orderBy: () => c,
      limit: () => c,
      then: (resolve: (v: FakeVolunteerRow[]) => void) => resolve(rows),
    };
    return c;
  }

  const fakeDb = {
    insert: () => ({
      values: (row: FakeVolunteerRow) => {
        dbMocks.insertedRows.push(row);
        return Promise.resolve();
      },
    }),
    select: () => chain(dbMocks.insertedRows),
  };

  return {
    ...actual,
    getDb: () => fakeDb,
  };
});

let app: express.Express;

beforeAll(async () => {
  const { volunteersRouter } = await import("@/routes/volunteers");
  const { errorHandler } = await import("@/middleware");
  const { colombiaTenantScope } = await import("@/lib/colombia-tenant");
  app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.tenantScope = colombiaTenantScope();
    next();
  });
  app.use("/api/volunteers", volunteersRouter);
  app.use(errorHandler);
});

beforeEach(() => {
  dbMocks.insertedRows.length = 0;
});

function validBody(overrides: Record<string, unknown> = {}) {
  return {
    name: "DEMO-Voluntario Uno",
    contact: "DEMO-3000000000",
    zone: "DEMO-Bogotá, Colombia",
    availability: "DEMO-10 horas por semana",
    offerTypes: ["persona"],
    digitalSkills: ["Verificación de datos"],
    crisisExperience: false,
    ...overrides,
  };
}

describe("POST /api/volunteers", () => {
  it("con body válido devuelve 200 { ok: true, id } y persiste la fila", async () => {
    const response = await request(app).post("/api/volunteers").send(validBody());

    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);
    expect(typeof response.body.id).toBe("string");
    expect(response.body.id.length).toBeGreaterThan(0);
    // El código único se devuelve UNA vez, al registrarse, y queda persistido.
    expect(response.body.code).toMatch(/^\d{6}$/);
    expect(dbMocks.insertedRows).toHaveLength(1);
    expect(dbMocks.insertedRows[0]).toMatchObject({
      id: response.body.id,
      code: response.body.code,
      name: "DEMO-Voluntario Uno",
      contact: "DEMO-3000000000",
      offerTypes: ["persona"],
      digitalSkills: ["Verificación de datos"],
      crisisExperience: false,
      status: "pending",
    });
  });

  it("persiste la rama de terreno (ciudad, entrenamiento, rol, vehículo)", async () => {
    const response = await request(app)
      .post("/api/volunteers")
      .send(
        validBody({
          offerTypes: ["persona", "transporte"],
          digitalSkills: undefined,
          crisisExperience: undefined,
          fieldCity: "DEMO-Quibdó",
          rescueTraining: false,
          fieldRole: "Logística",
          ownVehicle: true,
          offer: "DEMO-Camioneta disponible entre semana",
        }),
      );

    expect(response.status).toBe(200);
    expect(dbMocks.insertedRows[0]).toMatchObject({
      offerTypes: ["persona", "transporte"],
      fieldCity: "DEMO-Quibdó",
      rescueTraining: false,
      fieldRole: "Logística",
      ownVehicle: true,
      offer: "DEMO-Camioneta disponible entre semana",
    });
  });

  it("persiste el origen (source) cuando el formulario lo envía", async () => {
    const response = await request(app)
      .post("/api/volunteers")
      .send(validBody({ source: "utm:instagram/stories/llamado" }));

    expect(response.status).toBe(200);
    expect(dbMocks.insertedRows[0]).toMatchObject({
      source: "utm:instagram/stories/llamado",
    });
  });

  it("sin source el registro queda con source null (no inventa origen)", async () => {
    const response = await request(app).post("/api/volunteers").send(validBody());

    expect(response.status).toBe(200);
    expect(dbMocks.insertedRows[0]!.source).toBeNull();
  });

  it("rechaza offerTypes vacío (400) y no persiste nada", async () => {
    const response = await request(app)
      .post("/api/volunteers")
      .send(validBody({ offerTypes: [] }));

    expect(response.status).toBe(400);
    expect(dbMocks.insertedRows).toHaveLength(0);
  });

  it("rechaza offerTypes con valor fuera de catálogo (400)", async () => {
    const response = await request(app)
      .post("/api/volunteers")
      .send(validBody({ offerTypes: ["magia"] }));

    expect(response.status).toBe(400);
    expect(dbMocks.insertedRows).toHaveLength(0);
  });

  it("rechaza availability faltante (400) y no persiste nada", async () => {
    const { availability: _omit, ...body } = validBody();
    const response = await request(app).post("/api/volunteers").send(body);

    expect(response.status).toBe(400);
    expect(dbMocks.insertedRows).toHaveLength(0);
  });

  it("rechaza name faltante (400) y no persiste nada", async () => {
    const { name: _omit, ...body } = validBody();
    const response = await request(app).post("/api/volunteers").send(body);

    expect(response.status).toBe(400);
    expect(dbMocks.insertedRows).toHaveLength(0);
  });

  it("rechaza contact faltante (400) y no persiste nada", async () => {
    const { contact: _omit, ...body } = validBody();
    const response = await request(app).post("/api/volunteers").send(body);

    expect(response.status).toBe(400);
    expect(dbMocks.insertedRows).toHaveLength(0);
  });

  it("rechaza offer de más de 2000 caracteres (400) y no persiste nada", async () => {
    const response = await request(app)
      .post("/api/volunteers")
      .send(validBody({ offer: "a".repeat(2001) }));

    expect(response.status).toBe(400);
    expect(dbMocks.insertedRows).toHaveLength(0);
  });

  it("nunca persiste la IP cruda: ip_hash es un hash sha256 (o null), jamás el valor crudo", async () => {
    const rawIp = "203.0.113.42"; // TEST-NET-3 (RFC 5737): IP de documentación, no real

    const response = await request(app)
      .post("/api/volunteers")
      .set("cf-connecting-ip", rawIp)
      .send(validBody());

    expect(response.status).toBe(200);
    expect(dbMocks.insertedRows).toHaveLength(1);
    const stored = dbMocks.insertedRows[0]!.ipHash;

    expect(stored).not.toBeNull();
    expect(stored).not.toBe(rawIp);
    expect(stored).not.toContain(rawIp);
    expect(stored).toMatch(/^[0-9a-f]{64}$/); // sha256 hex, no la IP cruda
  });
});

describe("service de voluntarios: mapeo a VolunteerDTO (allowlist, nunca ip_hash)", () => {
  function seedRow(overrides: Partial<FakeVolunteerRow> = {}): FakeVolunteerRow {
    return {
      id: "demo-vol-1",
      name: "DEMO-Nombre Admin",
      contact: "DEMO-3000000001",
      code: "483920",
      offer: "DEMO-oferta",
      zone: "DEMO-zona",
      availability: "DEMO-puntual",
      offerTypes: ["persona"],
      digitalSkills: null,
      crisisExperience: null,
      fieldCity: null,
      rescueTraining: null,
      fieldRole: null,
      ownVehicle: null,
      source: null,
      status: "pending",
      notes: null,
      // Simula el peor caso: si la query alguna vez trajera la columna
      // ip_hash, el mapeo del service igual NO debe reexponerla en el DTO.
      ipHash: "deadbeefcafefeed0123456789abcdef0123456789abcdef0123456789abcd",
      createdAt: Date.now(),
      updatedAt: null,
      ...overrides,
    };
  }

  it("listVolunteers() nunca expone ipHash en el DTO", async () => {
    dbMocks.insertedRows.push(seedRow());
    const { listVolunteers } = await import("@/services/volunteers");

    const dtos = await listVolunteers();

    expect(dtos).toHaveLength(1);
    expect(dtos[0]).not.toHaveProperty("ipHash");
    expect(JSON.stringify(dtos[0])).not.toContain("deadbeef");
    expect(dtos[0]).toMatchObject({
      id: "demo-vol-1",
      name: "DEMO-Nombre Admin",
      status: "pending",
    });
  });

  it("getVolunteerById() nunca expone ipHash en el DTO", async () => {
    dbMocks.insertedRows.push(seedRow({ id: "demo-vol-2" }));
    const { getVolunteerById } = await import("@/services/volunteers");

    const dto = await getVolunteerById("demo-vol-2");

    expect(dto).not.toBeNull();
    expect(dto).not.toHaveProperty("ipHash");
    expect(JSON.stringify(dto)).not.toContain("deadbeef");
  });
});
