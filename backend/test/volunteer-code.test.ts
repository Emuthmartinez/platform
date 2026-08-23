import "./helpers";
import express from "express";
import request from "supertest";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { volunteerCodeDbMock } from "./helpers/volunteer-code-db";
import { colombiaTenantScope } from "@/lib/colombia-tenant";

const dbMocks = vi.hoisted(() => ({
  volunteers: [] as Array<Record<string, unknown>>,
  checkins: [] as Array<Record<string, unknown>>,
  reports: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/db")>();
  return volunteerCodeDbMock(actual, dbMocks);
});

const VOLUNTEER = { id: "vol-1", name: "DEMO-Voluntaria", code: "483920" };

let app: express.Express;

beforeAll(async () => {
  const { voluntariadoRouter } = await import("@/routes/voluntariado");
  const { reportsRouter } = await import("@/routes/reports");
  const { errorHandler } = await import("@/middleware");
  app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.tenantScope = colombiaTenantScope();
    next();
  });
  app.use("/api/voluntariado", voluntariadoRouter);
  app.use("/api/reports", reportsRouter);
  app.use(errorHandler);
});

beforeEach(() => {
  dbMocks.volunteers = [{ ...VOLUNTEER }];
  dbMocks.checkins = [];
  dbMocks.reports = [];
  dbMocks.volunteerInsertErrors = [];
  dbMocks.selectCalls = 0;
});

describe("código único en el registro (service)", () => {
  it("createVolunteer genera un código de 6 dígitos y lo persiste", async () => {
    dbMocks.volunteers = [];
    const { createVolunteer } = await import("@/services/volunteers");

    const created = await createVolunteer({
      name: "DEMO-Nuevo",
      contact: "DEMO-300",
      offer: "",
      zone: "DEMO-Pereira",
      availability: "DEMO-fines de semana",
      offerTypes: ["persona"],
    }, colombiaTenantScope());

    expect(created.code).toMatch(/^\d{6}$/);
    expect(dbMocks.volunteers[0]?.code).toBe(created.code);
    expect(dbMocks.selectCalls).toBe(0);
  });

  it("reintenta solo cuando el índice único detecta una colisión de código", async () => {
    dbMocks.volunteers = [];
    dbMocks.volunteerInsertErrors = [
      Object.assign(new Error("collision"), {
        code: "23505",
        constraint: "volunteers_code_unique",
      }),
    ];
    const { createVolunteer } = await import("@/services/volunteers");

    const created = await createVolunteer({
      name: "DEMO-Reintento",
      contact: "DEMO-301",
      offer: "",
      zone: "DEMO-Pereira",
      availability: "DEMO-mañana",
      offerTypes: ["persona"],
    }, colombiaTenantScope());

    expect(created.code).toMatch(/^\d{6}$/);
    expect(dbMocks.volunteers).toHaveLength(1);
    expect(dbMocks.selectCalls).toBe(0);
  });

  it("propaga otros errores de unicidad sin ocultarlos", async () => {
    dbMocks.volunteers = [];
    const idCollision = Object.assign(new Error("id collision"), {
      code: "23505",
      constraint: "volunteers_pkey",
    });
    dbMocks.volunteerInsertErrors = [idCollision];
    const { createVolunteer } = await import("@/services/volunteers");

    await expect(
      createVolunteer({
        name: "DEMO-Error",
        contact: "DEMO-302",
        offer: "",
        zone: "DEMO-Pereira",
        availability: "DEMO-tarde",
        offerTypes: ["persona"],
      }, colombiaTenantScope()),
    ).rejects.toBe(idCollision);
    expect(dbMocks.volunteers).toHaveLength(0);
  });
});

describe("POST /api/voluntariado/verificar-codigo", () => {
  it("código conocido → 200 con el nombre del voluntario", async () => {
    const response = await request(app)
      .post("/api/voluntariado/verificar-codigo")
      .send({ code: "483920" });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true, name: "DEMO-Voluntaria" });
  });

  it("acepta el código con espacios (se normaliza)", async () => {
    const response = await request(app)
      .post("/api/voluntariado/verificar-codigo")
      .send({ code: "483 920" });

    expect(response.status).toBe(200);
  });

  it("código desconocido → 404", async () => {
    dbMocks.volunteers = [];
    const response = await request(app)
      .post("/api/voluntariado/verificar-codigo")
      .send({ code: "000000" });

    expect(response.status).toBe(404);
  });

  it("código malformado → 400 de validación sin tocar la base", async () => {
    const response = await request(app)
      .post("/api/voluntariado/verificar-codigo")
      .send({ code: "12" });

    expect(response.status).toBe(400);
  });
});

describe("POST /api/voluntariado/checkin", () => {
  it("código válido → 201 y persiste lugar + nota ligados al voluntario", async () => {
    const response = await request(app)
      .post("/api/voluntariado/checkin")
      .send({
        code: "483920",
        place: "DEMO-Centro de acopio La Villa",
        note: "DEMO-Dejé la caja 12 en el estante B",
      });

    expect(response.status).toBe(201);
    expect(dbMocks.checkins).toHaveLength(1);
    expect(dbMocks.checkins[0]).toMatchObject({
      volunteerId: "vol-1",
      place: "DEMO-Centro de acopio La Villa",
      note: "DEMO-Dejé la caja 12 en el estante B",
    });
  });

  it("código inválido → 400 y no persiste nada", async () => {
    dbMocks.volunteers = [];
    const response = await request(app)
      .post("/api/voluntariado/checkin")
      .send({ code: "000000", place: "DEMO-Acopio" });

    expect(response.status).toBe(400);
    expect(dbMocks.checkins).toHaveLength(0);
  });

  it("sin lugar → 400 de validación", async () => {
    const response = await request(app)
      .post("/api/voluntariado/checkin")
      .send({ code: "483920", place: "" });

    expect(response.status).toBe(400);
    expect(dbMocks.checkins).toHaveLength(0);
  });

  it("con disponibilidad, talento y área → actualiza al voluntario y persiste el reporte", async () => {
    const response = await request(app)
      .post("/api/voluntariado/checkin")
      .send({
        code: "483920",
        place: "DEMO-Acopio La Villa",
        note: "DEMO-Llegaron 12 cajas de agua",
        availability: "Hoy",
        talent: "Logística",
        area: "DEMO-Pereira",
      });

    expect(response.status).toBe(201);
    expect(dbMocks.checkins[0]).toMatchObject({
      volunteerId: "vol-1",
      place: "DEMO-Acopio La Villa",
      note: "DEMO-Llegaron 12 cajas de agua",
    });
    expect(dbMocks.volunteers[0]).toMatchObject({
      availability: "Hoy",
      fieldRole: "Logística",
      zone: "DEMO-Pereira",
    });
  });
});

describe("POST /api/reports con volunteerCode (atribución)", () => {
  const reportBody = {
    type: "critical",
    lat: 4.8133,
    lng: -75.6961,
    place: "DEMO-Barrio Centro",
  };

  it("código válido → el reporte queda ligado al voluntario", async () => {
    const response = await request(app)
      .post("/api/reports")
      .send({ ...reportBody, volunteerCode: "483920" });

    expect(response.status).toBe(201);
    expect(dbMocks.reports[0]?.volunteerId).toBe("vol-1");
  });

  it("código inválido → 400 claro y NO se guarda el reporte", async () => {
    dbMocks.volunteers = [];
    const response = await request(app)
      .post("/api/reports")
      .send({ ...reportBody, volunteerCode: "000000" });

    expect(response.status).toBe(400);
    expect(response.body.error).toContain("código de voluntario");
    expect(dbMocks.reports).toHaveLength(0);
  });

  it("sin código → reporte anónimo normal (volunteerId null)", async () => {
    const response = await request(app).post("/api/reports").send(reportBody);

    expect(response.status).toBe(201);
    expect(dbMocks.reports[0]?.volunteerId).toBeNull();
  });
});
