/**
 * Idempotent operator bootstrap: create or promote a superadmin by email.
 *
 * Does not log the password. Does not run against Colombia production Neon.
 * Callers must pass confirm token `platform-operator-bootstrap` for a remote URL.
 */
import { randomUUID } from "crypto";
import { eq, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { SYSTEM_ADMIN_ROLE } from "@/auth/capabilities";
import { hashPassword } from "@/auth/password";
import { assertSafeDatabaseUrl } from "@/lib/ops-backfill";

export const OPERATOR_CONFIRM = "platform-operator-bootstrap";

/** Colombia production Neon branch marker. Never bootstrap operators there. */
export const COLOMBIA_PRODUCTION_DB_MARKERS = ["nameless-dew"] as const;

export interface EnsureSuperadminInput {
  email: string;
  password: string;
  name?: string;
  databaseUrl: string;
  confirm?: string;
  nodeEnv?: string;
}

export interface EnsureSuperadminResult {
  email: string;
  created: boolean;
  promoted: boolean;
}

export function assertNotColombiaProductionDatabase(url: string): void {
  const lower = url.toLowerCase();
  for (const marker of COLOMBIA_PRODUCTION_DB_MARKERS) {
    if (lower.includes(marker)) {
      throw new Error(
        "Refusing Colombia production Neon. Operator bootstrap is staging/isolated only.",
      );
    }
  }
}

export function normalizeOperatorEmail(raw: string): string {
  const email = raw.trim().toLowerCase();
  if (!email.includes("@") || email.length < 3 || email.length > 320) {
    throw new Error("ENSURE_SUPERADMIN_EMAIL is not a valid email.");
  }
  return email;
}

export async function ensureSuperadmin(
  input: EnsureSuperadminInput,
): Promise<EnsureSuperadminResult> {
  assertSafeDatabaseUrl(input.databaseUrl, {
    confirm: input.confirm,
    nodeEnv: input.nodeEnv,
    expectedConfirm: OPERATOR_CONFIRM,
  });
  assertNotColombiaProductionDatabase(input.databaseUrl);

  const email = normalizeOperatorEmail(input.email);
  const password = input.password;
  if (!password || password.length < 12) {
    throw new Error("ENSURE_SUPERADMIN_PASSWORD must be at least 12 characters.");
  }

  const db = getDb();
  const now = Date.now();
  const [adminRole] = await db
    .select({ id: schema.roles.id })
    .from(schema.roles)
    .where(sql`${schema.roles.name} = ${SYSTEM_ADMIN_ROLE} AND ${schema.roles.orgId} IS NULL`)
    .limit(1);
  if (!adminRole) {
    throw new Error("Seed admin role is missing. Run migrate/seedAuth first.");
  }

  const [existing] = await db
    .select({
      id: schema.users.id,
      isSuperAdmin: schema.users.isSuperAdmin,
    })
    .from(schema.users)
    .where(eq(schema.users.email, email))
    .limit(1);

  const passwordHash = await hashPassword(password);
  const name = input.name?.trim() || "Platform operator";

  if (existing) {
    const promoted = existing.isSuperAdmin !== true;
    await db
      .update(schema.users)
      .set({
        isSuperAdmin: true,
        status: "active",
        roleId: adminRole.id,
        passwordHash,
        name,
      })
      .where(eq(schema.users.id, existing.id));
    return { email, created: false, promoted };
  }

  await db.insert(schema.users).values({
    id: randomUUID(),
    email,
    name,
    passwordHash,
    roleId: adminRole.id,
    orgId: null,
    status: "active",
    isSuperAdmin: true,
    createdAt: now,
  });
  return { email, created: true, promoted: false };
}
