/**
 * Optional staging-only DEMO volunteer seed.
 *
 * NEVER runs in production. Requires ALLOW_STAGING_DEMO_SEED=1 and a host that
 * is NOT production Neon. Local compose still uses `npm run seed` (assertLocalOnly).
 *
 *   ALLOW_STAGING_DEMO_SEED=1 DATABASE_URL=… npx tsx src/seed/volunteers-demo.ts
 */
import { getDb, schema } from "@/db";
import { colombiaTenantScope } from "@/lib/colombia-tenant";
import { incidentOwnership } from "@/tenant/ownership";
import { buildFixtures, DEMO_PREFIX } from "./fixtures";

function assertStagingDemoAllowed(): void {
  if (process.env.NODE_ENV === "production") {
    throw new Error("[seed:volunteers-demo] NODE_ENV=production → abortado.");
  }
  if (process.env.ALLOW_STAGING_DEMO_SEED !== "1") {
    throw new Error(
      "[seed:volunteers-demo] falta ALLOW_STAGING_DEMO_SEED=1 (nunca auto en CI).",
    );
  }
  const url = process.env.DATABASE_URL ?? "";
  if (!url) throw new Error("[seed:volunteers-demo] DATABASE_URL no configurada.");
  // Hard reject obvious production hosts / pooler names used in prd.
  if (/neon\.tech/i.test(url) && /production|prd/i.test(url)) {
    throw new Error("[seed:volunteers-demo] URL parece producción → abortado.");
  }
  console.log(`[seed:volunteers-demo] allow-flag ok; prefix=${DEMO_PREFIX}`);
}

async function main(): Promise<void> {
  assertStagingDemoAllowed();
  const db = getDb();
  const { volunteers } = buildFixtures(Date.now());
  const ownership = incidentOwnership(colombiaTenantScope());
  await db
    .insert(schema.volunteers)
    .values(volunteers.map((row) => ({ ...row, ...ownership })))
    .onConflictDoNothing();
  console.log(`[seed:volunteers-demo] insertados/omitidos ${volunteers.length} DEMO-vol-*`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
