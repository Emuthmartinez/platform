import { eq, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { verifyPassword } from "@/auth/password";

export interface PlatformOperator {
  id: string;
  email: string;
  name: string;
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
  return row?.status === "active" ? { id: row.id, email: row.email, name: row.name } : null;
}

export async function loginPlatformOperator(
  email: string,
  password: string,
): Promise<PlatformOperator | null> {
  const [row] = await getDb()
    .select()
    .from(schema.platformOperators)
    .where(sql`lower(${schema.platformOperators.email}) = ${email.trim().toLowerCase()}`)
    .limit(1);
  const dummy = "$2b$12$0000000000000000000000000000000000000000000000000000z";
  const valid = await verifyPassword(password, row?.passwordHash ?? dummy);
  if (!row || row.status !== "active" || !valid) return null;
  await getDb()
    .update(schema.platformOperators)
    .set({ lastLoginAt: Date.now() })
    .where(eq(schema.platformOperators.id, row.id));
  return { id: row.id, email: row.email, name: row.name };
}
