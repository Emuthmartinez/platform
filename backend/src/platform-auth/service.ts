import { randomUUID } from "node:crypto";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { hashPassword, verifyPassword } from "@/auth/password";
import { badRequest, conflict, forbidden, notFound } from "@/lib/errors";
import {
  isPlatformCapability,
  PLATFORM_CAPABILITIES,
  type PlatformCapability,
} from "@/platform-auth/capabilities";

export interface PlatformOperator {
  id: string;
  email: string;
  name: string;
  capabilities: PlatformCapability[];
}

export interface PlatformOperatorAdminView extends PlatformOperator {
  status: string;
  accessBound: boolean;
  createdAt: number;
  lastLoginAt: number | null;
}

async function activeCapabilities(operatorId: string): Promise<PlatformCapability[]> {
  const rows = await getDb()
    .select({ capabilityKey: schema.platformOperatorGrants.capabilityKey })
    .from(schema.platformOperatorGrants)
    .where(and(
      eq(schema.platformOperatorGrants.operatorId, operatorId),
      isNull(schema.platformOperatorGrants.revokedAt),
    ))
    .orderBy(asc(schema.platformOperatorGrants.capabilityKey));
  return rows.map((row) => row.capabilityKey).filter(isPlatformCapability);
}

export async function loadPlatformOperator(id: string): Promise<PlatformOperator | null> {
  const [row] = await getDb()
    .select({
      id: schema.platformOperators.id,
      email: schema.platformOperators.email,
      name: schema.platformOperators.name,
      status: schema.platformOperators.status,
    })
    .from(schema.platformOperators)
    .where(eq(schema.platformOperators.id, id))
    .limit(1);
  if (!row || row.status !== "active") return null;
  return { ...row, capabilities: await activeCapabilities(row.id) };
}

export async function loginPlatformOperator(email: string, password: string): Promise<PlatformOperator | null> {
  const [row] = await getDb()
    .select()
    .from(schema.platformOperators)
    .where(sql`lower(${schema.platformOperators.email}) = ${email.trim().toLowerCase()}`)
    .limit(1);
  const dummy = "$2b$12$0000000000000000000000000000000000000000000000000000z";
  const valid = await verifyPassword(password, row?.passwordHash ?? dummy);
  if (!row || row.status !== "active" || !valid) return null;
  await getDb().update(schema.platformOperators).set({ lastLoginAt: Date.now() })
    .where(eq(schema.platformOperators.id, row.id));
  return loadPlatformOperator(row.id);
}

export async function loginPlatformOperatorWithAccess(input: {
  email: string;
  subject: string;
}): Promise<PlatformOperator | null> {
  const [row] = await getDb()
    .select()
    .from(schema.platformOperators)
    .where(sql`lower(${schema.platformOperators.email}) = ${input.email.trim().toLowerCase()}`)
    .limit(1);
  if (!row || row.status !== "active" || (row.accessSubject && row.accessSubject !== input.subject)) {
    return null;
  }
  if (!row.accessSubject) {
    await getDb().update(schema.platformOperators)
      .set({ accessSubject: input.subject, lastLoginAt: Date.now() })
      .where(and(eq(schema.platformOperators.id, row.id), isNull(schema.platformOperators.accessSubject)));
    const [bound] = await getDb().select({ accessSubject: schema.platformOperators.accessSubject })
      .from(schema.platformOperators).where(eq(schema.platformOperators.id, row.id)).limit(1);
    if (bound?.accessSubject !== input.subject) return null;
  } else {
    await getDb().update(schema.platformOperators).set({ lastLoginAt: Date.now() })
      .where(eq(schema.platformOperators.id, row.id));
  }
  return loadPlatformOperator(row.id);
}

export async function listPlatformOperators(): Promise<PlatformOperatorAdminView[]> {
  const rows = await getDb().select({
    id: schema.platformOperators.id,
    email: schema.platformOperators.email,
    name: schema.platformOperators.name,
    status: schema.platformOperators.status,
    accessSubject: schema.platformOperators.accessSubject,
    createdAt: schema.platformOperators.createdAt,
    lastLoginAt: schema.platformOperators.lastLoginAt,
  }).from(schema.platformOperators).orderBy(asc(schema.platformOperators.email));
  return Promise.all(rows.map(async (row) => ({
    id: row.id,
    email: row.email,
    name: row.name,
    status: row.status,
    accessBound: Boolean(row.accessSubject),
    createdAt: row.createdAt,
    lastLoginAt: row.lastLoginAt ?? null,
    capabilities: await activeCapabilities(row.id),
  })));
}

async function hasOtherOperatorManager(operatorId: string): Promise<boolean> {
  const [row] = await getDb().select({ id: schema.platformOperators.id })
    .from(schema.platformOperators)
    .innerJoin(schema.platformOperatorGrants, eq(schema.platformOperatorGrants.operatorId, schema.platformOperators.id))
    .where(and(
      eq(schema.platformOperators.status, "active"),
      sql`${schema.platformOperators.id} <> ${operatorId}`,
      eq(schema.platformOperatorGrants.capabilityKey, "platform:operators:manage"),
      isNull(schema.platformOperatorGrants.revokedAt),
    )).limit(1);
  return Boolean(row);
}

export async function createPlatformOperator(
  input: { email: string; name: string; capabilities: string[] },
  actorId: string,
): Promise<PlatformOperatorAdminView> {
  const capabilities = [...new Set(input.capabilities)];
  if (capabilities.some((key) => !isPlatformCapability(key))) throw badRequest("Unknown platform capability.");
  const id = randomUUID();
  try {
    await getDb().insert(schema.platformOperators).values({
      id,
      email: input.email.trim().toLowerCase(),
      name: input.name.trim(),
      passwordHash: await hashPassword(randomUUID()),
      status: "active",
      createdAt: Date.now(),
    });
  } catch (error) {
    if ((error as { code?: string }).code === "23505") throw conflict("Operator email already exists.");
    throw error;
  }
  if (capabilities.length) {
    const now = Date.now();
    await getDb().insert(schema.platformOperatorGrants).values(capabilities.map((capabilityKey) => ({
      operatorId: id,
      capabilityKey,
      grantedBy: actorId,
      grantedAt: now,
      reason: "Operator provisioned",
    })));
  }
  return (await listPlatformOperators()).find((operator) => operator.id === id)!;
}

export async function updatePlatformOperator(
  id: string,
  input: { name?: string; status?: "active" | "disabled"; capabilities?: string[] },
  actorId: string,
): Promise<PlatformOperatorAdminView> {
  const current = (await listPlatformOperators()).find((operator) => operator.id === id);
  if (!current) throw notFound("Platform operator not found.");
  if (id === actorId && input.status === "disabled") throw forbidden("You cannot disable yourself.");
  const capabilities = input.capabilities ? [...new Set(input.capabilities)] : current.capabilities;
  if (capabilities.some((key) => !isPlatformCapability(key))) throw badRequest("Unknown platform capability.");
  const removesManagement = current.capabilities.includes("platform:operators:manage")
    && !capabilities.includes("platform:operators:manage");
  const disablesManager = current.status === "active" && input.status === "disabled"
    && current.capabilities.includes("platform:operators:manage");
  if ((removesManagement || disablesManager) && !(await hasOtherOperatorManager(id))) {
    throw forbidden("At least one active operator manager must remain.");
  }

  if (input.name !== undefined || input.status !== undefined) {
    await getDb().update(schema.platformOperators).set({
      ...(input.name === undefined ? {} : { name: input.name.trim() }),
      ...(input.status === undefined ? {} : { status: input.status }),
    }).where(eq(schema.platformOperators.id, id));
  }

  if (input.capabilities) {
    const now = Date.now();
    await getDb().insert(schema.platformOperatorGrants).values(
      PLATFORM_CAPABILITIES.map((capabilityKey) => {
        const enabled = capabilities.includes(capabilityKey);
        return {
          operatorId: id,
          capabilityKey,
          grantedBy: actorId,
          grantedAt: now,
          revokedBy: enabled ? null : actorId,
          revokedAt: enabled ? null : now,
          reason: enabled ? "Capability granted" : "Capability revoked",
        };
      }),
    ).onConflictDoUpdate({
      target: [schema.platformOperatorGrants.operatorId, schema.platformOperatorGrants.capabilityKey],
      set: {
        grantedBy: sql`excluded.granted_by`,
        grantedAt: sql`excluded.granted_at`,
        revokedBy: sql`excluded.revoked_by`,
        revokedAt: sql`excluded.revoked_at`,
        reason: sql`excluded.reason`,
      },
    });
  }
  return (await listPlatformOperators()).find((operator) => operator.id === id)!;
}

export { PLATFORM_CAPABILITIES };
