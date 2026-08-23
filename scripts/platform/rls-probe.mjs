#!/usr/bin/env node
/**
 * KTD5 / U6 RLS feasibility probe against Neon HTTP (`neon()`).
 *
 * Reads DATABASE_URL from the environment. Never prints the URL.
 * Touches only public.rls_probe_items (synthetic). Do not point this
 * at Colombia production.
 *
 * Usage:
 *   DATABASE_URL=... node scripts/platform/rls-probe.mjs
 */
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(
  join(dirname(fileURLToPath(import.meta.url)), "../../backend/package.json"),
);
const { neon } = require("@neondatabase/serverless");

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const sql = neon(url);

function labels(rows) {
  return rows.map((row) => row.label).sort();
}

function lastResult(batch) {
  return batch[batch.length - 1];
}

async function main() {
  const role = await sql`
    SELECT current_user AS current_user_name,
           session_user AS session_user_name,
           r.rolsuper,
           r.rolbypassrls,
           r.rolcanlogin
    FROM pg_roles r
    WHERE r.rolname = current_user
  `;

  const ownership = await sql`
    SELECT c.relname AS table_name,
           pg_get_userbyid(c.relowner) AS owner,
           c.relrowsecurity AS rls_enabled,
           c.relforcerowsecurity AS rls_forced
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'rls_probe_items'
  `;

  const runtimeRole = await sql`
    SELECT rolname, rolsuper, rolbypassrls, rolcanlogin
    FROM pg_roles
    WHERE rolname = 'rls_probe_runtime'
  `;

  await sql`DELETE FROM rls_probe_items`;
  await sql`
    INSERT INTO rls_probe_items (organization_id, incident_id, label)
    VALUES
      ('org-a', 'inc-a', 'tenant-a'),
      ('org-b', 'inc-b', 'tenant-b')
  `;

  const asOwnerNoClaims = await sql`
    SELECT label FROM rls_probe_items ORDER BY label
  `;

  const asRuntimeOrgA = await sql.transaction([
    sql`SELECT set_config('role', 'rls_probe_runtime', true)`,
    sql`SELECT set_config('app.current_org_id', 'org-a', true)`,
    sql`SELECT set_config('app.current_incident_id', 'inc-a', true)`,
    sql`SELECT label FROM rls_probe_items ORDER BY label`,
  ]);

  let insertCrossDenied = false;
  let insertCrossDeniedError = null;
  try {
    await sql.transaction([
      sql`SELECT set_config('role', 'rls_probe_runtime', true)`,
      sql`SELECT set_config('app.current_org_id', 'org-a', true)`,
      sql`SELECT set_config('app.current_incident_id', 'inc-a', true)`,
      sql`
        INSERT INTO rls_probe_items (organization_id, incident_id, label)
        VALUES ('org-b', 'inc-b', 'cross-write')
      `,
    ]);
  } catch (err) {
    insertCrossDenied = true;
    insertCrossDeniedError = String(err?.message ?? err);
  }

  const insertSame = await sql.transaction([
    sql`SELECT set_config('role', 'rls_probe_runtime', true)`,
    sql`SELECT set_config('app.current_org_id', 'org-a', true)`,
    sql`SELECT set_config('app.current_incident_id', 'inc-a', true)`,
    sql`
      INSERT INTO rls_probe_items (organization_id, incident_id, label)
      VALUES ('org-a', 'inc-a', 'tenant-a-write')
      RETURNING label
    `,
  ]);

  const updateCross = await sql.transaction([
    sql`SELECT set_config('role', 'rls_probe_runtime', true)`,
    sql`SELECT set_config('app.current_org_id', 'org-a', true)`,
    sql`SELECT set_config('app.current_incident_id', 'inc-a', true)`,
    sql`
      UPDATE rls_probe_items
      SET label = 'hijacked'
      WHERE organization_id = 'org-b' AND incident_id = 'inc-b'
      RETURNING label
    `,
  ]);

  const deleteCross = await sql.transaction([
    sql`SELECT set_config('role', 'rls_probe_runtime', true)`,
    sql`SELECT set_config('app.current_org_id', 'org-a', true)`,
    sql`SELECT set_config('app.current_incident_id', 'inc-a', true)`,
    sql`
      DELETE FROM rls_probe_items
      WHERE organization_id = 'org-b' AND incident_id = 'inc-b'
      RETURNING label
    `,
  ]);

  const runtimeNoClaims = await sql.transaction([
    sql`SELECT set_config('role', 'rls_probe_runtime', true)`,
    sql`SELECT label FROM rls_probe_items ORDER BY label`,
  ]);

  const freshBatchNoClaims = await sql`
    SELECT label FROM rls_probe_items ORDER BY label
  `;

  const leftoverGucs = await sql`
    SELECT current_setting('app.current_org_id', true) AS org_id,
           current_setting('app.current_incident_id', true) AS incident_id,
           current_user AS current_user_name
  `;

  const report = {
    ownerRole: role[0],
    runtimeRole: runtimeRole[0] ?? null,
    table: ownership[0],
    ownerSeesBothWithoutClaims: labels(asOwnerNoClaims),
    runtimeOrgASees: labels(lastResult(asRuntimeOrgA)),
    insertSameTenant: labels(lastResult(insertSame)),
    insertCrossDenied,
    insertCrossDeniedError,
    updateCrossReturned: labels(lastResult(updateCross)),
    deleteCrossReturned: labels(lastResult(deleteCross)),
    runtimeNoClaimsSees: labels(lastResult(runtimeNoClaims)),
    freshHttpBatchSeesAsOwner: labels(freshBatchNoClaims),
    leftoverGucsAfterFreshBatch: leftoverGucs[0],
  };

  console.log(JSON.stringify(report, null, 2));
}

main().catch((err) => {
  console.error(String(err?.message ?? err));
  process.exit(1);
});
