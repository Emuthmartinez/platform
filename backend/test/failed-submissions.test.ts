/**
 * Mantenimiento de `failed_submissions` (Ley 1581): retención por el cron y
 * supresión al resolver una solicitud de eliminación de datos.
 *
 * PII sintética: nombres/emails DEMO, nunca datos reales. La DB local se
 * comparte entre archivos (ver test/helpers.ts); cada test usa emails únicos
 * para no pisar filas de otros.
 */
import { randomUUID } from "crypto";
import { eq, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { testTenantOwnership } from "./helpers";
import { colombiaTenantScope } from "@/lib/colombia-tenant";

let db: typeof import("@/db");
let svc: typeof import("@/services/failed-submissions");
let deletionSvc: typeof import("@/services/data-deletion");

const DAY = 24 * 60 * 60 * 1000;

async function seedFailed(input: {
  email: string;
  createdAt: number;
  replayedAt?: number | null;
  form?: string;
}): Promise<string> {
  const { failedSubmissions } = db.schema;
  const id = randomUUID();
  await db.getDb().insert(failedSubmissions).values({
    id,
    form: input.form ?? "volunteers",
    payload: { name: "DEMO Persona", email: input.email, phone: "+57 300 000 0000" },
    errorCode: "42703",
    createdAt: input.createdAt,
    replayedAt: input.replayedAt ?? null,
      ...testTenantOwnership(),
    });
  return id;
}

async function existsFailed(id: string): Promise<boolean> {
  const { failedSubmissions } = db.schema;
  const rows = await db
    .getDb()
    .select({ id: failedSubmissions.id })
    .from(failedSubmissions)
    .where(eq(failedSubmissions.id, id));
  return rows.length > 0;
}

beforeAll(async () => {
  db = await import("@/db");
  svc = await import("@/services/failed-submissions");
  deletionSvc = await import("@/services/data-deletion");
});

describe("drainFailedSubmissionsRetention", () => {
  it("purga reinyectadas >7d y pendientes >30d; conserva lo reciente", async () => {
    const now = Date.now();
    const oldReplayed = await seedFailed({
      email: `demo-ret-a-${randomUUID()}@example.test`,
      createdAt: now - 10 * DAY,
      replayedAt: now - 8 * DAY,
    });
    const freshReplayed = await seedFailed({
      email: `demo-ret-b-${randomUUID()}@example.test`,
      createdAt: now - 2 * DAY,
      replayedAt: now - 1 * DAY,
    });
    const oldPending = await seedFailed({
      email: `demo-ret-c-${randomUUID()}@example.test`,
      createdAt: now - 31 * DAY,
    });
    const freshPending = await seedFailed({
      email: `demo-ret-d-${randomUUID()}@example.test`,
      createdAt: now - 1 * DAY,
    });

    const r = await svc.drainFailedSubmissionsRetention(now);

    expect(r.replayedPurged).toBeGreaterThanOrEqual(1);
    expect(r.unreplayedPurged).toBeGreaterThanOrEqual(1);
    expect(await existsFailed(oldReplayed)).toBe(false);
    expect(await existsFailed(oldPending)).toBe(false);
    expect(await existsFailed(freshReplayed)).toBe(true);
    expect(await existsFailed(freshPending)).toBe(true);
    // El backlog cuenta las pendientes que quedan (al menos la fresca).
    expect(r.pendingBacklog).toBeGreaterThanOrEqual(1);
  });

  it("es idempotente: una segunda corrida no encuentra nada nuevo que purgar", async () => {
    const now = Date.now();
    await svc.drainFailedSubmissionsRetention(now);
    const r2 = await svc.drainFailedSubmissionsRetention(now);
    expect(r2.replayedPurged).toBe(0);
    expect(r2.unreplayedPurged).toBe(0);
  });
});

describe("purgeFailedSubmissionsByEmail", () => {
  it("borra solo los envíos cuyo payload contiene el email, sin importar mayúsculas", async () => {
    const now = Date.now();
    const email = `Demo-Purga-${randomUUID()}@Example.Test`;
    const mine = await seedFailed({ email, createdAt: now });
    const other = await seedFailed({
      email: `demo-ajeno-${randomUUID()}@example.test`,
      createdAt: now,
    });

    const purged = await svc.purgeFailedSubmissionsByEmail(email.toLowerCase());

    expect(purged).toBe(1);
    expect(await existsFailed(mine)).toBe(false);
    expect(await existsFailed(other)).toBe(true);
  });

  it("email vacío es no-op", async () => {
    expect(await svc.purgeFailedSubmissionsByEmail("   ")).toBe(0);
  });

  it("escapa comodines de LIKE: un email con % no arrastra filas ajenas", async () => {
    const now = Date.now();
    const other = await seedFailed({
      email: `demo-comodin-${randomUUID()}@example.test`,
      createdAt: now,
    });
    // "%@%" matchearía cualquier payload con un email si no se escapara.
    expect(await svc.purgeFailedSubmissionsByEmail("%@%")).toBe(0);
    expect(await existsFailed(other)).toBe(true);
  });
});

describe("updateDeletionRequestStatus — supresión Ley 1581", () => {
  it("resolver una solicitud purga los envíos fallidos de ese email", async () => {
    const now = Date.now();
    const email = `demo-1581-${randomUUID()}@example.test`;
    const failedId = await seedFailed({ email, createdAt: now, form: "missing" });

    const req = await deletionSvc.createDeletionRequest({
      name: "DEMO Solicitante",
      email,
      details: "Solicitud sintética de test",
      ipHash: "demo-hash",
    }, colombiaTenantScope());

    const result = await deletionSvc.updateDeletionRequestStatus(req.id, "resolved");
    expect(result).not.toBeNull();
    expect(result!.item.status).toBe("resolved");
    expect(result!.purgedFailedSubmissions).toBe(1);
    expect(await existsFailed(failedId)).toBe(false);
  });

  it("rechazar una solicitud NO purga nada", async () => {
    const now = Date.now();
    const email = `demo-1581-rech-${randomUUID()}@example.test`;
    const failedId = await seedFailed({ email, createdAt: now });

    const req = await deletionSvc.createDeletionRequest({
      name: "DEMO Solicitante",
      email,
      ipHash: "demo-hash",
    }, colombiaTenantScope());
    const result = await deletionSvc.updateDeletionRequestStatus(req.id, "rejected");
    expect(result!.purgedFailedSubmissions).toBe(0);
    expect(await existsFailed(failedId)).toBe(true);

    // Limpieza del dato sintético pendiente para no engordar el backlog.
    await db.getDb().delete(db.schema.failedSubmissions).where(sql`id = ${failedId}`);
  });
});
