// Tests del flujo de tareas de voluntarios: endpoints públicos por token
// (ver/responder) y la acción admin de asignar (crea token + correo).
// `@/db` mockeado por TABLA (el `from(table)` decide qué filas devuelve);
// el gate de requireCapability lo cubre la matriz — aquí se mockea.
import "./helpers";
import express from "express";
import request from "supertest";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
  tasks: [] as Array<Record<string, unknown>>,
  assignments: [] as Array<Record<string, unknown>>,
  volunteers: [] as Array<Record<string, unknown>>,
  updates: [] as Array<Record<string, unknown>>,
  deletes: [] as number,
  sendMail: vi.fn(),
}));

vi.mock("@/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/db")>();

  function rowsFor(table: unknown): Array<Record<string, unknown>> {
    if (table === actual.schema.volunteerTasks) return dbMocks.tasks;
    if (table === actual.schema.volunteerAssignments) return dbMocks.assignments;
    if (table === actual.schema.volunteers) return dbMocks.volunteers;
    return [];
  }

  function chain() {
    let rows: Array<Record<string, unknown>> = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- doble mínimo de la cadena fluida de Drizzle, solo para tests
    const c: any = {
      from: (table: unknown) => {
        rows = rowsFor(table);
        return c;
      },
      innerJoin: () => {
        rows = rows.map((r) => ({
          ...r,
          volunteerName: dbMocks.volunteers[0]?.name ?? "DEMO-Voluntaria",
        }));
        return c;
      },
      where: () => c,
      orderBy: () => c,
      limit: () => c,
      then: (resolve: (v: Array<Record<string, unknown>>) => void) => resolve(rows),
    };
    return c;
  }

  return {
    ...actual,
    getDb: () => ({
      select: () => chain(),
      insert: (table: unknown) => ({
        values: (row: Record<string, unknown>) => {
          rowsFor(table).push(row);
          return Promise.resolve();
        },
      }),
      update: (table: unknown) => ({
        set: (value: Record<string, unknown>) => ({
          where: () => {
            dbMocks.updates.push({ table, ...value });
            // El where se ignora: aplicar el set a todas las filas de la tabla
            // para que los re-reads (recomputeTaskStatus) vean el nuevo estado.
            rowsFor(table).forEach((row) => Object.assign(row, value));
            return Promise.resolve();
          },
        }),
      }),
      delete: () => ({
        where: () => {
          dbMocks.deletes += 1;
          return Promise.resolve();
        },
      }),
    }),
  };
});

vi.mock("@/middleware/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/middleware/auth")>();
  return {
    ...actual,
    requireCapability: () => (
      _req: express.Request,
      _res: express.Response,
      next: express.NextFunction,
    ) => next(),
  };
});

vi.mock("@/auth/mailer", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/auth/mailer")>();
  return { ...actual, sendVolunteerAssignmentEmail: dbMocks.sendMail };
});

const TASK = {
  id: "task-1",
  title: "DEMO-Llevar víveres a Manizales",
  description: "DEMO-dos cajas",
  kind: "terreno",
  city: "DEMO-Manizales",
  originName: "DEMO-Terminal de Pereira",
  originLat: 4.8133,
  originLng: -75.6961,
  destName: "DEMO-Refugio Manizales",
  destLat: 5.0689,
  destLng: -75.5174,
  transportNote: "DEMO-Bus 6am, plataforma 3",
  status: "open",
  createdAt: Date.now(),
  updatedAt: null,
};

const VOLUNTEER = { id: "vol-1", name: "DEMO-Voluntaria", contact: "demo@example.org" };

const ASSIGNMENT = {
  id: "asg-1",
  taskId: "task-1",
  volunteerId: "vol-1",
  token: "a".repeat(48),
  status: "offered",
  createdAt: Date.now(),
  updatedAt: null,
};

let app: express.Express;

beforeAll(async () => {
  const { voluntariadoRouter } = await import("@/routes/voluntariado");
  const { volunteerTasksActionsRouter } = await import(
    "@/public-api/routers/volunteer-tasks-actions.router"
  );
  const { errorHandler } = await import("@/middleware");
  const { colombiaTenantScope } = await import("@/lib/colombia-tenant");
  app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.tenantScope = colombiaTenantScope();
    next();
  });
  app.use("/api/voluntariado", voluntariadoRouter);
  app.use("/api/public/volunteer-tasks", volunteerTasksActionsRouter);
  app.use(errorHandler);
});

beforeEach(() => {
  dbMocks.tasks = [{ ...TASK }];
  dbMocks.volunteers = [{ ...VOLUNTEER }];
  dbMocks.assignments = [{ ...ASSIGNMENT }];
  dbMocks.updates = [];
  dbMocks.deletes = 0;
  dbMocks.sendMail.mockReset();
});

describe("GET /api/voluntariado/:token", () => {
  it("devuelve la tarea con sus puntos y el nombre del voluntario", async () => {
    const response = await request(app).get(`/api/voluntariado/${"a".repeat(48)}`);

    expect(response.status).toBe(200);
    expect(response.body.volunteerName).toBe("DEMO-Voluntaria");
    expect(response.body.status).toBe("offered");
    expect(response.body.task).toMatchObject({
      title: "DEMO-Llevar víveres a Manizales",
      originLat: 4.8133,
      destLat: 5.0689,
      transportNote: "DEMO-Bus 6am, plataforma 3",
    });
  });

  it("404 si el token no existe", async () => {
    dbMocks.assignments = [];
    const response = await request(app).get(`/api/voluntariado/${"b".repeat(48)}`);
    expect(response.status).toBe(404);
  });
});

describe("POST /api/voluntariado/:token/responder", () => {
  it("aceptar: offered → accepted", async () => {
    const response = await request(app)
      .post(`/api/voluntariado/${"a".repeat(48)}/responder`)
      .send({ action: "aceptar" });

    expect(response.status).toBe(200);
    expect(response.body.status).toBe("accepted");
    expect(dbMocks.updates.some((u) => u.status === "accepted")).toBe(true);
  });

  it("terminar desde offered es transición inválida → 404", async () => {
    const response = await request(app)
      .post(`/api/voluntariado/${"a".repeat(48)}/responder`)
      .send({ action: "terminar" });

    expect(response.status).toBe(404);
  });

  it("rechazar: offered → declined y la tarea vuelve a open", async () => {
    const response = await request(app)
      .post(`/api/voluntariado/${"a".repeat(48)}/responder`)
      .send({ action: "rechazar" });

    expect(response.status).toBe(200);
    expect(response.body.status).toBe("declined");
    expect(response.body.taskStatus).toBe("open");
  });

  it("terminar desde accepted → done y la tarea queda done", async () => {
    dbMocks.assignments = [{ ...ASSIGNMENT, status: "accepted" }];
    const response = await request(app)
      .post(`/api/voluntariado/${"a".repeat(48)}/responder`)
      .send({ action: "terminar" });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ status: "done", taskStatus: "done" });
  });
});

describe("POST /api/public/volunteer-tasks/:id/assign", () => {
  it("crea la asignación con token y envía el correo", async () => {
    dbMocks.assignments = [];
    dbMocks.sendMail.mockResolvedValue({ sent: true });

    const response = await request(app)
      .post("/api/public/volunteer-tasks/task-1/assign")
      .send({ volunteerId: "vol-1" });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ ok: true, sentTo: "demo@example.org" });
    expect(dbMocks.assignments).toHaveLength(1);
    expect(dbMocks.assignments[0]!.token).toMatch(/^[0-9a-f]{48}$/);
    expect(dbMocks.updates.some((u) => u.status === "assigned")).toBe(true);
    // El correo de asignación cuenta como contacto: pending → contacted.
    expect(dbMocks.updates.some((u) => u.status === "contacted")).toBe(true);
    expect(dbMocks.sendMail).toHaveBeenCalledOnce();
    const [to, payload] = dbMocks.sendMail.mock.calls[0]!;
    expect(to).toBe("demo@example.org");
    expect(payload.assignmentUrl).toContain(`/voluntariado/${dbMocks.assignments[0]!.token}`);
    expect(payload.task.title).toBe("DEMO-Llevar víveres a Manizales");
  });

  it("400 si el contacto del voluntario no es correo; no crea nada", async () => {
    dbMocks.assignments = [];
    dbMocks.volunteers = [{ ...VOLUNTEER, contact: "+57 300 000 0000" }];

    const response = await request(app)
      .post("/api/public/volunteer-tasks/task-1/assign")
      .send({ volunteerId: "vol-1" });

    expect(response.status).toBe(400);
    expect(dbMocks.assignments).toHaveLength(0);
  });

  it("503 si el correo falla y COMPENSA borrando la asignación huérfana", async () => {
    dbMocks.assignments = [];
    dbMocks.sendMail.mockResolvedValue({ sent: false });

    const response = await request(app)
      .post("/api/public/volunteer-tasks/task-1/assign")
      .send({ volunteerId: "vol-1" });

    expect(response.status).toBe(503);
    expect(dbMocks.deletes).toBe(1);
  });

  it("404 si la tarea no existe o está cerrada", async () => {
    dbMocks.tasks = [];

    const response = await request(app)
      .post("/api/public/volunteer-tasks/none/assign")
      .send({ volunteerId: "vol-1" });

    expect(response.status).toBe(404);
  });
});
