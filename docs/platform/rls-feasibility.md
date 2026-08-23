# KTD5 — Neon HTTP RLS feasibility (U6)

**Date:** 2026-08-23
**Branch:** Neon `u6-rls-probe` (`br-noisy-hill-axwaks2j`), parent Colombia
staging, expires 2026-08-24T02:00:00Z.
**Database:** `neondb`. Synthetic table only: `public.rls_probe_items`.
**Driver:** `@neondatabase/serverless` `neon()` HTTP `transaction([])`
(same class as the production Worker driver). Claims used
`set_config(..., true)` so they are transaction-local.

This probe did not read or write crisis tables.

## Role and ownership

| Role | superuser | BYPASSRLS | LOGIN | Notes |
| --- | --- | --- | --- | --- |
| `neondb_owner` (connection) | false | **true** | true | table owner |
| `rls_probe_runtime` | false | false | false | granted to owner for `SET ROLE` |

Table `rls_probe_items`: owner `neondb_owner`, `ENABLE ROW LEVEL SECURITY`,
`FORCE ROW LEVEL SECURITY`. Policy `FOR ALL` compares `organization_id` and
`incident_id` to `current_setting('app.current_org_id', true)` and
`current_setting('app.current_incident_id', true)` in both `USING` and
`WITH CHECK`.

`CREATE ROLE` on this branch did **not** appear on Colombia staging
(`br-shy-king-ax96do57`).

## Results

| Step | Result |
| --- | --- |
| Owner SELECT with no claims | sees both tenants (`tenant-a`, `tenant-b`) |
| HTTP batch: `SET ROLE` runtime + org-a/inc-a claims, SELECT | sees only `tenant-a` |
| Same batch pattern, INSERT same tenant | allowed (`tenant-a-write`) |
| Same batch pattern, INSERT other tenant | rejected: `new row violates row-level security policy` |
| Same batch pattern, UPDATE/DELETE other tenant | zero rows (hidden, not an error) |
| HTTP batch: `SET ROLE` runtime, no claims, SELECT | empty |
| New HTTP request as owner, no claims | sees remaining owner-visible rows; GUC values are not `org-a`/`inc-a` |

`SET ROLE` inside the HTTP batch used `set_config('role', 'rls_probe_runtime', true)`.

## Decision

KTD5 stands: **tenant enforcement stays application-level** for Phase B.

RLS as defense-in-depth is **feasible on Neon HTTP** without changing
driver, but only when every protected statement runs in one `neon()`
transaction that:

1. Sets a runtime role that is not superuser, not table owner, and not
   `BYPASSRLS`.
2. Sets both tenant claims with transaction-local `set_config`.
3. Then SELECT/INSERT/UPDATE/DELETE.

`FORCE ROW LEVEL SECURITY` is **not enough** on the default Neon owner:
`neondb_owner` has `rolbypassrls = true`, so the owner still sees every
row. Do not treat “RLS enabled + forced” as isolation while the Worker
connects as that owner.

Do not schedule a live-table RLS migration until each tenant-scoped
call site uses that batch path (KTD5). Re-evaluate after U7 repositories
exist.

Probe objects (`rls_probe_items`, `rls_probe_runtime`) were dropped after
this record. The disposable branch still expires at 2026-08-24T02:00:00Z.

## How to re-run

Point `DATABASE_URL` at a **disposable** branch that already has
`rls_probe_items` and `rls_probe_runtime`. Never production.

```bash
cd backend
DATABASE_URL=... node ../scripts/platform/rls-probe.mjs
```

The script never prints the URL.
