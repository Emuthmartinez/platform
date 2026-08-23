/**
 * Service del flujo de tareas para voluntarios ("hombre del medio"): el
 * equipo crea tareas en el panel (con puntos geográficos opcionales), las
 * asigna a un voluntario y la persona responde por el link tokenizado del
 * correo — sin cuentas.
 *
 * PROHIBIDO db.transaction(...) aquí (invariante Workers, ver CLAUDE.md):
 * solo sentencias únicas + claims condicionales (UPDATE ... WHERE status
 * esperado) + recomputo del estado de la tarea desde sus asignaciones.
 */
import { randomBytes, randomUUID } from "crypto";
import { desc, eq, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { incidentOwnership } from "@/tenant/ownership";
import type { TenantScope } from "@/tenant/scope";

const { volunteerTasks, volunteerAssignments, volunteers } = schema;

export type TaskKind = "digital" | "terreno";
export type TaskStatus = "open" | "assigned" | "done" | "cancelled";
export type AssignmentStatus = "offered" | "accepted" | "done" | "declined";

export interface TaskDTO {
  id: string;
  title: string;
  description: string;
  kind: string;
  city: string | null;
  originName: string | null;
  originLat: number | null;
  originLng: number | null;
  destName: string | null;
  destLat: number | null;
  destLng: number | null;
  transportNote: string | null;
  status: TaskStatus;
  createdAt: number;
  updatedAt: number | null;
}

export interface TaskInput {
  title: string;
  description?: string;
  kind: TaskKind;
  city?: string;
  originName?: string;
  originLat?: number;
  originLng?: number;
  destName?: string;
  destLat?: number;
  destLng?: number;
  transportNote?: string;
}

type TaskRow = typeof volunteerTasks.$inferSelect;

function toTaskDTO(r: TaskRow): TaskDTO {
  return {
    id: r.id,
    title: r.title,
    description: r.description,
    kind: r.kind,
    city: r.city,
    originName: r.originName,
    originLat: r.originLat,
    originLng: r.originLng,
    destName: r.destName,
    destLat: r.destLat,
    destLng: r.destLng,
    transportNote: r.transportNote,
    status: r.status as TaskStatus,
    createdAt: Number(r.createdAt),
    updatedAt: r.updatedAt === null ? null : Number(r.updatedAt),
  };
}

export async function createTask(input: TaskInput, scope: TenantScope): Promise<{ id: string }> {
  const db = await getDb();
  const id = randomUUID();
  const now = Date.now();
  await db.insert(volunteerTasks).values({
    id,
    title: input.title,
    description: input.description ?? "",
    kind: input.kind,
    city: input.city ?? null,
    originName: input.originName ?? null,
    originLat: input.originLat ?? null,
    originLng: input.originLng ?? null,
    destName: input.destName ?? null,
    destLat: input.destLat ?? null,
    destLng: input.destLng ?? null,
    transportNote: input.transportNote ?? null,
    status: "open",
    createdAt: now,
    updatedAt: now,
    ...incidentOwnership(scope),
  });
  return { id };
}

export async function listTasks(): Promise<TaskDTO[]> {
  const db = await getDb();
  const rows = await db
    .select()
    .from(volunteerTasks)
    .orderBy(desc(volunteerTasks.createdAt));
  return rows.map(toTaskDTO);
}

export async function getTaskById(id: string): Promise<TaskDTO | null> {
  const db = await getDb();
  const rows = await db.select().from(volunteerTasks).where(eq(volunteerTasks.id, id)).limit(1);
  const r = rows[0];
  return r ? toTaskDTO(r) : null;
}

export async function updateTask(
  id: string,
  patch: { status?: TaskStatus; transportNote?: string; description?: string },
): Promise<TaskDTO | null> {
  const db = await getDb();
  const values: Record<string, unknown> = { updatedAt: Date.now() };
  if (patch.status !== undefined) values.status = patch.status;
  if (patch.transportNote !== undefined) values.transportNote = patch.transportNote;
  if (patch.description !== undefined) values.description = patch.description;
  await db.update(volunteerTasks).set(values).where(eq(volunteerTasks.id, id));
  return getTaskById(id);
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type AssignResult =
  | { ok: true; assignmentId: string; token: string; task: TaskDTO; volunteerEmail: string; volunteerName: string }
  | { ok: false; reason: "not-found" | "not-email" };

/**
 * Crea la asignación (token incluido) y pasa la tarea a assigned. Valida ANTES
 * de insertar: si el contacto del voluntario no es un correo, no se crea nada
 * (el link solo llega por email).
 */
export async function assignVolunteer(
  taskId: string,
  volunteerId: string,
  scope: TenantScope,
): Promise<AssignResult> {
  const db = await getDb();
  const task = await getTaskById(taskId);
  if (!task || task.status === "cancelled" || task.status === "done") {
    return { ok: false, reason: "not-found" };
  }
  const vRows = await db
    .select({ name: volunteers.name, contact: volunteers.contact })
    .from(volunteers)
    .where(eq(volunteers.id, volunteerId))
    .limit(1);
  const volunteer = vRows[0];
  if (!volunteer) return { ok: false, reason: "not-found" };
  if (!EMAIL_RE.test(volunteer.contact)) return { ok: false, reason: "not-email" };

  const now = Date.now();
  const assignmentId = randomUUID();
  const token = randomBytes(24).toString("hex");
  await db.insert(volunteerAssignments).values({
    id: assignmentId,
    taskId,
    volunteerId,
    token,
    status: "offered",
    createdAt: now,
    updatedAt: now,
    ...incidentOwnership(scope),
  });
  // open → assigned solo si sigue abierta (claim condicional).
  await db
    .update(volunteerTasks)
    .set({ status: "assigned", updatedAt: now })
    .where(sql`${volunteerTasks.id} = ${taskId} AND ${volunteerTasks.status} = 'open'`);
  // El correo de asignación ya es un contacto: pending → contacted (claim).
  await db
    .update(volunteers)
    .set({ status: "contacted", updatedAt: now })
    .where(sql`${volunteers.id} = ${volunteerId} AND ${volunteers.status} = 'pending'`);
  return {
    ok: true,
    assignmentId,
    token,
    task,
    volunteerEmail: volunteer.contact,
    volunteerName: volunteer.name,
  };
}

/**
 * Compensación de assignVolunteer: si el correo falla DESPUÉS de crear la
 * asignación, la borramos para que el reintento del admin parta de cero
 * (sin asignaciones huérfanas cuyo link nunca llegó).
 */
export async function deleteAssignment(assignmentId: string): Promise<void> {
  const db = await getDb();
  await db.delete(volunteerAssignments).where(eq(volunteerAssignments.id, assignmentId));
}

/** Vista pública de una asignación por su token (sin PII del voluntario salvo su nombre). */
export async function getAssignmentByToken(token: string): Promise<{
  status: AssignmentStatus;
  volunteerName: string;
  task: TaskDTO;
} | null> {
  const db = await getDb();
  const rows = await db
    .select({
      status: volunteerAssignments.status,
      taskId: volunteerAssignments.taskId,
      volunteerName: volunteers.name,
    })
    .from(volunteerAssignments)
    .innerJoin(volunteers, eq(volunteers.id, volunteerAssignments.volunteerId))
    .where(eq(volunteerAssignments.token, token))
    .limit(1);
  const r = rows[0];
  if (!r) return null;
  const task = await getTaskById(r.taskId);
  if (!task) return null;
  return { status: r.status as AssignmentStatus, volunteerName: r.volunteerName, task };
}

export type AssignmentAction = "accept" | "decline" | "done";

const ALLOWED_FROM: Record<AssignmentAction, AssignmentStatus[]> = {
  accept: ["offered"],
  decline: ["offered", "accepted"],
  done: ["accepted"],
};

const ACTION_TO_STATUS: Record<AssignmentAction, AssignmentStatus> = {
  accept: "accepted",
  decline: "declined",
  done: "done",
};

/**
 * Responde una asignación por token. Devuelve el nuevo estado, o null si el
 * token no existe o la transición no es válida desde el estado actual
 * (claim condicional: el UPDATE solo muerde si el status es uno permitido).
 */
export async function respondToAssignment(
  token: string,
  action: AssignmentAction,
): Promise<{ status: AssignmentStatus; taskStatus: TaskStatus } | null> {
  const db = await getDb();
  const rows = await db
    .select({
      id: volunteerAssignments.id,
      status: volunteerAssignments.status,
      taskId: volunteerAssignments.taskId,
    })
    .from(volunteerAssignments)
    .where(eq(volunteerAssignments.token, token))
    .limit(1);
  const current = rows[0];
  if (!current) return null;
  const from = current.status as AssignmentStatus;
  if (!ALLOWED_FROM[action].includes(from)) return null;

  const next = ACTION_TO_STATUS[action];
  const now = Date.now();
  await db
    .update(volunteerAssignments)
    .set({ status: next, updatedAt: now })
    .where(sql`${volunteerAssignments.id} = ${current.id} AND ${volunteerAssignments.status} = ${from}`);

  const taskStatus = await recomputeTaskStatus(current.taskId);
  return { status: next, taskStatus };
}

/**
 * Estado de la tarea derivado de sus asignaciones: done si hay alguna
 * terminada y ninguna activa (offered/accepted); open si no queda ninguna
 * activa ni terminada; assigned mientras haya activas. Nunca pisa cancelled.
 */
async function recomputeTaskStatus(taskId: string): Promise<TaskStatus> {
  const db = await getDb();
  const rows = await db
    .select({ status: volunteerAssignments.status })
    .from(volunteerAssignments)
    .where(eq(volunteerAssignments.taskId, taskId));
  const active = rows.filter((r) => r.status === "offered" || r.status === "accepted").length;
  const done = rows.filter((r) => r.status === "done").length;
  const next: TaskStatus = active > 0 ? "assigned" : done > 0 ? "done" : "open";
  await db
    .update(volunteerTasks)
    .set({ status: next, updatedAt: Date.now() })
    .where(sql`${volunteerTasks.id} = ${taskId} AND ${volunteerTasks.status} != 'cancelled'`);
  return next;
}
