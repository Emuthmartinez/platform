import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { hashPassword } from "@/auth/password";
import { getDb, schema } from "@/db";
import { PLATFORM_CAPABILITIES } from "@/platform-auth/capabilities";

const email = process.env.PLATFORM_OPERATOR_EMAIL?.trim().toLowerCase();
const password = process.env.PLATFORM_OPERATOR_PASSWORD;
const name = process.env.PLATFORM_OPERATOR_NAME?.trim() || "Mallanet operator";

if (!email || !password || password.length < 12) {
  throw new Error(
    "PLATFORM_OPERATOR_EMAIL and PLATFORM_OPERATOR_PASSWORD (>=12 chars) are required.",
  );
}

const db = getDb();
const [existing] = await db
  .select({ id: schema.platformOperators.id })
  .from(schema.platformOperators)
  .where(sql`lower(${schema.platformOperators.email}) = ${email}`)
  .limit(1);

let operatorId = existing?.id;
if (!operatorId) {
  operatorId = randomUUID();
  await db.insert(schema.platformOperators).values({
    id: operatorId,
    email,
    name,
    passwordHash: await hashPassword(password),
    status: "active",
    createdAt: Date.now(),
  });
  console.log(`Created platform operator: ${email}.`);
}

await db.insert(schema.platformOperatorGrants).values(
  PLATFORM_CAPABILITIES.map((capabilityKey) => ({
    operatorId,
    capabilityKey,
    grantedBy: operatorId,
    grantedAt: Date.now(),
    reason: "Bootstrap platform operator authority",
  })),
).onConflictDoNothing();
console.log(`Ensured platform operator capabilities: ${email}.`);
