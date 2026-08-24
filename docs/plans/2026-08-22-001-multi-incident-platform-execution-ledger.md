---
title: Multi-incident platform execution ledger
date: 2026-08-22
bootstrap_sha: 83b7c1669fda091f092edcb3f470a1e81f5669ba
plan_review_sha: 89089da
cache_review_sha: d106977
status: phase-b-u8-tighten-applied-pending-merge
supersedes: docs/plans/2026-08-21-001-multi-incident-platform-execution-ledger.md
---

# Multi-incident platform execution ledger

Authoritative plans:

1. `docs/plans/2026-08-12-001-refactor-multi-incident-platform-plan.md`
2. `docs/plans/2026-08-14-001-feat-platform-operability-plan.md`
3. `docs/plans/2026-08-12-001-refactor-multi-incident-platform-diagrams.md`

This ledger maps requirement → KTD → unit → files → tests → evidence → SHA →
status. Complete means acceptance evidence, not the existence of files.

## Phase 0 — repository reality (2026-08-22)

| Item | Value |
|---|---|
| Implementation worktree | `/Users/eduardomuthmartinez/Mallanet/Colombia/platform-impl` |
| Branch | `feat/platform-u18-ledger` (U18 dual-write staging evidence) |
| Immutable bootstrap SHA | `83b7c1669fda091f092edcb3f470a1e81f5669ba` (origin/main, PR #53) |
| User checkout (do not touch) | `/Users/eduardomuthmartinez/Mallanet/Colombia/repo` on `fix/frontend-backend-contracts` (`89089da`) |
| Untracked on user checkout | `.agents/skills/disaster-*`, `.agents/skills/geo/**`, `.agents/skills/neon*` — preserve, do not absorb |
| Plans on origin/main | absent before this unit; copied into the worktree in Phase 0 |
| Do not absorb | `8f12eaa` Access-doc edits and pptx |
| origin/staging | `22340434` Merge PR #72 (U18 dual-write). Recorded 2026-08-23 |
| Local `main` | stale (`3dacec2`, 242 behind). Ignore. |
| Plan original review SHA | `89089da` (ancestor of main) |
| Cache addendum SHA | `d106977` (ancestor of main) |
| `89089da..origin/main` | 67 commits total, **10 first-parent** (not 67 first-parent) |

First-parent since `89089da`: map cleanup (#15), chip (#43), volunteer ficha (#44),
staging observability (#46), query-family (#49), donate (#50), stripe audit (#51),
campaign reconstrucción (#47+#52), brand icons (#53).

### Live audit at `83b7c16` (material to later units)

| Assumption | Status |
|---|---|
| `packages/contracts` | absent |
| Workflows set `APP_BUILD_SHA` | no (Next configs already read it) |
| Frontend/admin Docker | `npm ci \|\| npm install` |
| Backend Docker | `npm run build \|\| echo ...` swallows `tsc` failure |
| HTTP clients | `as T` in frontend and admin |
| `trust proxy` | `true` in `server.ts` (U9) |
| `workers_dev` | unset → Cloudflare default **true** (U9 must set false) |
| Process cache | 24 `cached()` sites, 35 `invalidate()` call sites |
| JSON edge allowlist | includes `/api/deceased` |
| Prod frontend/admin | automatic `wrangler deploy` on push; smoke is HTTP 200 only |
| Prod backend | manual dispatch + column drift **before** deploy |
| Staging backend | no drift preflight |
| Compose prod | `backend`/`worker` `depends_on: migrate` |
| Auth | NULL-org / `is_system` wildcard / `is_super_admin` (U30, parked) |
| Drift gate schema import | `schema.ts` only — **misses campaign tables** |
| Platform GitHub repo | interim `Emuthmartinez/platform` from `83b7c16`; intended `mallanet/platform` (B2 transfer) |
| GitHub Environments with required reviewers | only `copilot`; production-* do not exist yet |

Operability U23–U33 remain **parked**: U21/U22 are incomplete and no second-incident
driver is named.

## Dependency graph (executable)

```
U0 → U1 → U4 → U2, U3; U1 → U5; U2+U3+U5 → U16 → U6 → U19 → U7 → U9 → U20 → U34
                                                              ↘ U18 → U8 → U10 → U11 → U12…
U23–U33 PARKED until U21+U22 and a named second-incident driver
U35 starts deterministic shadow; not a U21 gate
```

**Next executable unit:** merge U8 tighten to Colombia `staging` (schema
already applied), port the same commits to isolated `platform` `main`,
then U34 (Upstash behind the provider-neutral cache port) and U10 scoped
repositories. Do not merge Colombia `staging` to `main`. Do not apply on
production Neon. Skip mixed-scope `audit_log` until its fail-closed
classifier ships.
U19 imports from Colombia `origin/main` after Phase A lands there. Do not
copy Colombia Doppler tokens onto the platform repo. Do not deploy the
platform clone onto terremotocolombia.co Workers. Do not enable Queue v2
producers.

## Unit ledger

### U0 — Release-control prerequisites

| Field | Value |
|---|---|
| Requirements | R19, R20 |
| KTDs | KTD15, KTD17 |
| Depends on | none |
| Source SHA | `83b7c16` |
| Status | staging evidence complete; production dry-run blocked (B0) |
| Rollback | revert the U0 PR; uploaded Worker versions have no traffic until promote. After promote: `wrangler versions deploy <previous-id>@100%` |
| Blocker | B0 staging-to-production dry run; B1 GitHub Environment required reviewers |
| PR/commit | [PR #54](https://github.com/mallanet/Terremotocolombia/pull/54) merged to `staging` as `4f0cd85` |

**Evidence (2026-08-22, staging):**

- GitHub Actions `deploy-staging.yml` run `32578744556` on merge of #54: schema-capability gate **before** API `wrangler deploy --env staging`; frontend and admin deploys; domain smoke including served SHA. Conclusion: **success**.
- Production traffic was not changed. Promote workflows were not run.

**Evidence (2026-08-22, worktree):**

- SHA mismatch refuse: `backend/test/lib/promote-identity.test.ts`
- Domain smoke vs healthy readyz: same file `evaluateDomainSmoke`
- Campaign tables in drift inventory: `backend/test/lib/schema-capability.test.ts`
- Docker fail-closed: `scripts/release/assert-docker-fail-closed.sh` + `backend/test/lib/docker-fail-closed.test.ts`
- Mixed-version shape fixtures: `node scripts/compat/check-fixtures.mjs`
- Served identity: health JSON + `x-app-build-sha` (`request-context.test.ts`, admin health tests)
- Backend: lint, typecheck, worker tsc, `npm test` 80 files / 767 tests
- Frontend: lint (existing warnings only), typecheck, `npm test` 39 files / 189 tests
- Admin: lint, typecheck, `npm test` 32 files / 172 tests
- Production dry-run: **not run** (B0)

### U1 — Contracts package scaffold and distribution proof

| Field | Value |
|---|---|
| Requirements | R1 |
| KTDs | KTD1, KTD2 |
| Depends on | U0 |
| Status | merged to `staging` as `8cf24e6` (PR #55) |
| Rollback | revert the U1 PR. Production is unchanged until a later promote. |

**Evidence (local, 2026-08-22):**

- Source-form `@mallanet/contracts` with `zod` peer `^3.23.8`
- Envelope tests: 10 passed
- Backend `tsc` consumes the TypeScript source (no `dist/` fallback)
- `wrangler deploy --dry-run` bundle contains `@mallanet/contracts`
- Frontend 40/192, admin 32/172
- CI on PR #55: all jobs green after `install-links=true` (copy, not symlink)
- Merged to `staging` as `8cf24e6`

### U4 — Validation telemetry and enforce flag

| Field | Value |
|---|---|
| Requirements | R2 |
| KTDs | KTD4 |
| Depends on | U1 |
| Status | merged to `staging` as `297306e` (PR #56) |
| Rollback | revert the U4 PR. Production stays on report mode. |

**Evidence (2026-08-22):**

- `validateContract` / `readContract` never cast `raw` to T
- Production defaults to report; development/test always enforce
- Frontend mismatch events reuse `client_error` with endpoint + issue paths only
- CI on PR #56: all jobs green
- Merged to `staging` as `297306e`

### U5 — Envelope canon and admin adapter

| Field | Value |
|---|---|
| Requirements | R4, R5 |
| KTDs | KTD3 |
| Depends on | U1 |
| Status | merged to `staging` as `1df8361` (PR #57) |
| Rollback | revert the U5 PR. No live admin call site opts into `schema` yet. |

**Evidence (2026-08-22):**

- Named list shapes in `packages/contracts/README.md`
- `hospitalsBareListSchema` for `GET /api/hospitals`
- `readAdminResult` never throws; live BFF call sites stay opt-in
- CI on PR #57: all jobs green
- Merged to `staging` as `1df8361`

### U2 — Reports contracts (additive)

| Field | Value |
|---|---|
| Requirements | R1, R4, R5 |
| KTDs | KTD1 |
| Depends on | U4 |
| Status | merged to `staging` as `6df6207` (PR #58) |
| Rollback | revert the U2 PR. Wire JSON is unchanged. |

**Evidence (2026-08-22):**

- `packages/contracts/src/reports.ts` matches live list/create/detail/confirm JSON
- Frontend `readReportsList` uses report mode; missing `totalPages` defaults to 1
- GET bodies have no `editToken`
- CI on PR #58: all jobs green
- Merged to `staging` as `6df6207`

### U3 — Needs async-job envelope (additive)

| Field | Value |
|---|---|
| Requirements | R1, R4, R5 |
| KTDs | KTD3 |
| Depends on | U4 |
| Status | merged to `staging` as `90bc30d` (PR #59) |
| Rollback | revert the U3 PR. Wire JSON is unchanged. Disabled `/api/needs` stays a generic 404. |

**Evidence (2026-08-22):**

- POST 202 and GET status parse through shared contracts
- Frontend poll fails closed on a mismatch
- Public `result` rejects extra citizen fields
- CI on PR #59: all jobs green
- Merged to `staging` as `90bc30d`

### U16 — OpenAPI baseline and oasdiff CI gate

| Field | Value |
|---|---|
| Requirements | R16 |
| KTDs | KTD11 |
| Depends on | U2, U3, U5 |
| Status | merged to `staging` as `33ef83e` (PR #60) |
| Rollback | revert the U16 PR. Runtime `/api/docs` stays gated by `ENABLE_API_DOCS`. |

**Evidence (2026-08-22):**

- Hybrid generator: JSDoc + crud-factory + contract overlay
- `cd backend && npm run openapi:generate` → `docs/api/openapi.json`
- Coverage: 136 paths (10 `contracts`, 66 `legacy-crud`, 60 `legacy-jsdoc`)
- Overlay paths stay `contracts`: healthz/readyz, public reports, `/api/needs*`
- oasdiff v1.29.1; gate `oasdiff breaking --fail-on WARN`
- CI job `contract compatibility (OpenAPI + oasdiff)` green on PR #60
- Merged to `staging` as `33ef83e`

This gate is **not** on Colombia `origin/main` (`83b7c16`). It reaches the
platform clone only through U19 after Phase A commits land on Colombia `main`.

### U6 — Platform repo bootstrap

| Field | Value |
|---|---|
| Requirements | R6; instantiates KD1 |
| KTDs | KD1, KTD5 |
| Depends on | U2, U3, U5, U16 |
| Status | clone complete on interim personal repo; org transfer still open (B2) |
| Rollback | delete or archive `Emuthmartinez/platform`; Colombia production is unchanged |

**Evidence (2026-08-23):**

- `gh repo create mallanet/platform` failed: `Emuthmartinez cannot create a repository for mallanet`
- User approved create under `Emuthmartinez`. Repo:
  https://github.com/Emuthmartinez/platform
- Clone SHA: Colombia `origin/main` `83b7c1669fda091f092edcb3f470a1e81f5669ba`
- Isolation commit `5934084`: deploy/monitor/verify-jobs are dispatch-only and
  skip unless `vars.ENABLE_PLATFORM_DEPLOYS == 'true'`. No Colombia Doppler
  tokens on the clone. GitHub Actions was disabled until that commit was on
  `main`, then re-enabled for CI.
- drizzle-kit `0.31.10` in its own commit `0babcfb`. `drizzle-kit generate`
  reported no schema changes.
- RLS probe on disposable Neon branch `u6-rls-probe`
  (`br-noisy-hill-axwaks2j`, parent staging, expires 2026-08-24T02:00:00Z).
  Synthetic table only. Record:
  https://github.com/Emuthmartinez/platform/blob/main/docs/platform/rls-feasibility.md
- KTD5 stands: app-level enforcement. Neon owner has `BYPASSRLS`. FORCE RLS
  does not bind that owner. A non-owner runtime role plus one HTTP `neon()`
  batch can isolate tenants.
- Probe table and role dropped after the record. Branch still expires.
- Platform HEAD after U6 commits: `1e7f019`
- Isolated Neon project `mallanet-platform` (`hidden-cell-49890973`), empty
  of crisis data. Doppler project `mallanet-platform` in the Furbo workplace:
  `stg`/`dev` hold `DATABASE_URL`; `prd` has no database URL. Clone migrations
  applied on that branch. Read-only `DOPPLER_TOKEN` / `DOPPLER_TOKEN_STAGING`
  set on `Emuthmartinez/platform` for CI. `ENABLE_PLATFORM_DEPLOYS` unset.

**Not claimed (plan verification, deferred):**

- OpenAPI oasdiff CI on the platform clone (not on bootstrap SHA)
- Staging deploy of three apps **from the platform repo** (would overwrite
  Colombia staging Workers). Colombia staging stays on this repo. U7 schema
  on Colombia staging is a copy of the expand SQL, not a Worker cutover.

### U7 — Platform core schema (expand)

| Field | Value |
|---|---|
| Requirements | R6, R7, R10 |
| KTDs | KTD6, KTD7, KTD10, KTD14 |
| Depends on | U6 |
| Status | expand merged on platform `main`; applied on Colombia staging Neon; production Neon untouched |
| Rollback | revert the Colombia staging PR; drop isolated Neon project if abandoning the clone. Do not roll back staging SQL without a matching code revert. |
| PR/commit | [platform PR #1](https://github.com/Emuthmartinez/platform/pull/1) merged `93188d4`; Colombia staging PR follows |

**Evidence (2026-08-23, isolated Neon `hidden-cell-49890973`):**

- Classification artifact `docs/platform/table-classification.json`: 65
  Drizzle tables (including campaign). CI step
  `npm run check:table-classification`.
- `0014_platform_core`: `organizations`, `incidents` unique
  `(organization_id, id)`, `deployments` hostname PK + composite FK. Seed
  hostnames match `config/deployment.config.json`. Mixed org/incident pair
  rejected (`platform-core-tenants.test.ts`).
- Domain-group expands `0015`–`0022`: nullable `organization_id` /
  `incident_id`, composite FKs `NOT VALID`. `audit_log` mixed-scope CHECK.
  Campaign expand is handwritten SQL (tables stay out of drizzle-kit
  generate).
- Drift after apply: 65 tables, 764 columns, OK.
- `drizzle-kit generate` empty after the sequence.
- Journal: 23 migrations, unique increasing `when`.
- Platform PR #1 merged to `Emuthmartinez/platform` `main` as `93188d4`
  (merge commit, expand history kept).

**Evidence (2026-08-23, Colombia staging Neon `br-shy-king-ax96do57`):**

- Same expand SQL applied **before** schema code merge (migrate-first).
- `__drizzle_migrations` count after U7: 23. After U9 seed `0023`: 24.
  Seed: `org_mallanet` / `inc_terremoto_colombia_2026` plus production
  hostnames from `config/deployment.config.json`. Staging hostnames landed
  in `0023`.
- Production branch `br-nameless-dew-axx1c59w`: `organizations` absent.
- Colombia staging PR #63 merged as `03187b11`. Workers on staging run
  U7 schema-aware code. Extra nullable columns do not change those SELECTs.

**Not claimed:**

- U8 tighten / `audit_log` mixed-scope backfill
- Apply on Colombia production Neon

### U9 — Tenant resolution middleware

| Field | Value |
|---|---|
| Requirements | R8 |
| KTDs | KTD7, KTD12, KTD21 |
| Depends on | U7 |
| Status | complete on Colombia staging and platform `main` |
| Rollback | revert the Colombia staging PR; `workers_dev: false` reverts with it. Do not drop `0023` rows while unknown-host 404 is live. |
| PR/commit | Colombia [PR #64](https://github.com/mallanet/Terremotocolombia/pull/64) `78c5167`; platform [PR #2](https://github.com/Emuthmartinez/platform/pull/2) `4921cc75` |

**Evidence (2026-08-23, staging Neon `br-shy-king-ax96do57`):**

- `0023_staging_deployments` applied before Worker code that 404s unknown
  hosts. Rows: `staging.terremotocolombia.co`,
  `api-staging.terremotocolombia.co`, `admin-staging.terremotocolombia.co`,
  `localhost`. Production Neon untouched.

**Evidence (2026-08-23, Colombia staging deploy):**

- `deploy-staging.yml` run `32615653782` on merge of #64: schema-capability
  gate, API/admin/frontend deploys, domain smoke. Conclusion: **success**.
- Live `api-staging` `/api/readyz` `200` with SHA `78c5167`. `/api/healthz`
  `200`. `/api/reports` `200` (`x-json-edge-cache: miss`). Staging web `200`.
- Production traffic was not changed. `workers_dev: false` is now on the
  staging Workers. Do not merge `staging` to `main`.

**Evidence (2026-08-23, worktree):**

- Trusted authority: `new URL(request.url).hostname` in the Worker Fetch
  handler; Express uses `x-mallanet-trusted-hostname` only.
  `PINNED_DEPLOYMENT_HOSTNAME` for development/test without that header.
- Unknown host: generic `{ error: "Ruta no encontrada." }` before JSON/photo
  cache and before tenant-scoped handlers. `/api/healthz` and `/api/readyz`
  skip tenant lookup.
- `workers_dev: false` in backend, frontend, and admin wrangler configs,
  top-level and `env.staging`. No `routes`.
- Edge cache keys include tenant partition and allowlisted Origin.
  Hits issue a fresh `X-Request-Id`. Rate-limit Valkey keys include
  org+incident; `EDGE_RATE_LIMITER` stays `flood:<ip>`.
- Tests: `backend/test/tenant-hostname.test.ts`,
  `backend/test/tenant-resolution.test.ts`, updated JSON/photo cache tests.

**Evidence (2026-08-23, `Emuthmartinez/platform`):**

- [PR #2](https://github.com/Emuthmartinez/platform/pull/2) merged to `main`
  as `4921cc75`. CI green. Isolation held: `ENABLE_PLATFORM_DEPLOYS` unset;
  merge ran CI only. No Worker deploy onto terremotocolombia.co.
- Isolated Neon `hidden-cell-49890973` `deployments` includes staging,
  localhost, and the production hostname rows from U7. `0023` is idempotent.
- `json-edge-cache.ts` reads `APP_BUILD_SHA` locally (clone has no U0
  `build-identity.ts`). Admin HTTP client kept its Result helper and only
  merged the trusted-hostname header.

**Not claimed:**

- U8 tighten / `audit_log` mixed-scope backfill
- Apply on Colombia production Neon
- Merge Colombia `staging` to `main`

### U20 — Background, offline-state, and cache protocol migration

| Field | Value |
|---|---|
| Requirements | R9, R18, R21 |
| KTDs | KTD18, KTD57 (registry feed for U34; no Upstash in U20) |
| Depends on | U7, U9 |
| Status | consumer-first complete on Colombia staging (process-cache, Queue/Cron, browser/SW/query). v2 producers remain off. |
| Rollback | revert the staging PR. Process-cache, queue consumers, and browser protocol are expand-only; producers still emit v1. |
| PR/commit | Process-cache: Colombia [PR #67](https://github.com/mallanet/Terremotocolombia/pull/67) `db71fb5`. Queue/Cron: Colombia [PR #68](https://github.com/mallanet/Terremotocolombia/pull/68) `0aab9b9`. Browser/SW/query: Colombia [PR #70](https://github.com/mallanet/Terremotocolombia/pull/70) `4ff92db`. Platform queues: [PR #3](https://github.com/Emuthmartinez/platform/pull/3). Platform browser: [PR #4](https://github.com/Emuthmartinez/platform/pull/4). |

**Evidence (2026-08-23, process-cache, Colombia staging):**

- [PR #67](https://github.com/mallanet/Terremotocolombia/pull/67) merged as
  `db71fb5`. Public JSON shapes unchanged. `cached()` takes a `ProcessCache`.
  Tenant partition `t:{org}:{incident}:{epoch}`; earthquakes and ResponseGrid
  use `GLOBAL_PROCESS_CACHE`. `invalidate(cache)` clears one partition.
  Registry: `docs/platform/cache-registry.md`.

**Evidence (2026-08-23, Queue/Cron consumer-first, Colombia staging):**

- [PR #68](https://github.com/mallanet/Terremotocolombia/pull/68) merged as
  `0aab9b9`. `deploy-staging.yml` run `32618498054`: schema-capability gate,
  API/admin/frontend deploys, domain smoke. Conclusion: **success**.
- Live `api-staging` `/api/readyz` `200` with SHA `0aab9b9`. `/api/healthz`
  `200`. Production traffic was not changed. Producers still emit v1.

**Evidence (2026-08-23, Queue/Cron consumer-first, worktree):**

- Exact queue registry (`backend/src/lib/queue-registry.ts`) matches
  `wrangler.jsonc` producer, consumer, and DLQ names. Substring hits are
  `unknown`. Compose names: `needs-publication`, `patient-imports`. Matcher
  is Cloudflare-only (no BullMQ matcher queue today).
- Dual decoder in `packages/contracts` + `backend/src/lib/queue-protocol.ts`.
  v1 bodies map to Colombia tenant ids. v2 envelopes keep the declared
  tenant. Producers still emit v1. Poison / unsupported version / wrong
  family → `retry()`.
- Unknown queue → `queue.quarantine` in `audit_log`. Ack only after the
  receipt persists (3 in-process attempts, then `retry()`).
- DLQ receipts redact citizen fields and keep import `errorSummary`,
  including nested v2 `payload.errorSummary`. Ack only after persist.
- Cron unknown expression returns `unhandled` and persists `cron.unhandled`.
  Idempotency key is tenant + job-kind + 5-minute window. Incident
  enumeration is Colombia-only. Earthquake `sync.fetchedAt` is unchanged.
- Tests: `packages/contracts/test/queue-protocol.test.ts`,
  `backend/test/lib/queue-protocol.test.ts`,
  `backend/test/lib/queue-registry.test.ts`, updated
  `backend/test/queue-consumer.test.ts` and `backend/test/cron-jobs.test.ts`.

**Evidence (2026-08-23, browser/SW/query, Colombia staging):**

- [PR #70](https://github.com/mallanet/Terremotocolombia/pull/70) merged as
  `4ff92db`. `deploy-staging.yml` run `32639844662`: schema-capability
  gate, API/admin/frontend deploys, domain smoke. Conclusion: **success**.
- Live `api-staging` `/api/readyz` `200` with SHA `4ff92db`. `/api/healthz`
  `200`. Production traffic was not changed. Producers still emit v1.

**Evidence (2026-08-23, browser/SW/query, worktree):**

- IndexedDB `emergency-offline` stays. Dual-read v1; write v2 with tenant
  ids, `idempotencyKey`, `producerBuildSha`, and status. Migrated v1 rows
  are `verification_required` and are not auto-flushed. Auto-delete only
  after a confirmed durable POST. Never delete on 403, validation, or
  migrate failure.
- TanStack keys: `[org, incident, epoch, …]`. Earthquakes stay
  `["g", "earthquakes", …]` (KTD10). Admin `scopedQueryKey` does not prefix
  `["auth","me"]` or invite tokens. Scope change clears the client cache.
- Next ISR tags: `incident:{org}:{incident}:{epoch}`.
- Service-worker cache names: `mallanet-e0-{org}-{incident}-{kind}`. Keep
  `*-v9`. Activate deletes only owned `mallanet-` names not in KEEP.
  Anonymous public JSON allowlist; chat, patients, photo JSON, and
  credentialed requests bypass.
- Registry: `docs/platform/browser-storage-registry.md`.

**Evidence (2026-08-23, `Emuthmartinez/platform`):**

- [PR #3](https://github.com/Emuthmartinez/platform/pull/3) ports the Queue
  consumer-first decoder. Schemas live in
  `backend/src/lib/queue-protocol-schema.ts` because this clone has no
  `packages/contracts` yet.
- [PR #4](https://github.com/Emuthmartinez/platform/pull/4) ports the
  browser/SW/query slice. `frontend/lib/build-identity.ts` is the small U0
  helper this slice needs. Isolation: `ENABLE_PLATFORM_DEPLOYS` unset;
  merge must run CI only.

**Not claimed:**

- v2 producer flag (plan step 6)
- Merge Colombia `staging` to `main`

### U18 — Dual-write organization and incident on every write

| Field | Value |
|---|---|
| Requirements | R6, R7, R9 |
| KTDs | KTD6, KTD13 |
| Depends on | U7, U9, U20 consumer-first (queue decoder already maps v1 to Colombia) |
| Status | complete on Colombia staging; platform PR open |
| Rollback | revert the Worker version or the staging PR. Columns stay nullable. Producers still emit v1. Do not point Colombia DNS at the platform clone. |
| PR/commit | Colombia [PR #72](https://github.com/mallanet/Terremotocolombia/pull/72) merged as `22340434`. Platform [PR #5](https://github.com/Emuthmartinez/platform/pull/5). |

**Evidence (2026-08-23, Colombia staging deploy):**

- `deploy-staging.yml` run `32649421183` on merge of #72: schema-capability
  gate, API/admin/frontend deploys, domain smoke including served SHA.
  Conclusion: **success**.
- Live `api-staging` `/api/readyz` `200` with SHA
  `223404340dd3f74d30140f2deab80b3a73f66834`. `/api/healthz` `200`.
- Production `/api/healthz` `200` with body `{"ok":true}` and no new SHA.
  Production traffic was not changed. Do not merge `staging` to `main`.

**Evidence (2026-08-23, worktree):**

- Helper `backend/src/tenant/ownership.ts`: `incidentOwnership`,
  `tenantJobFields` (extra fields on a still-v1 body),
  `includesUnscopedLegacyRows` for Colombia NULL pre-U18 rows.
- HTTP writers call `requireTenantScope(req)`. Queue and cron pass an
  explicit `TenantScope`. AsyncLocalStorage is not authorization (KTD13).
- Inventory and rollback: `docs/platform/execution-boundaries.md`.
- Tests: `backend/test/tenant-ownership.test.ts`,
  `backend/test/tenant-write.test.ts` (report/chat/import stamp; needs
  status does not cross incidents). Isolated routers pin
  `req.tenantScope = colombiaTenantScope()`.
- Backend: lint, typecheck, worker tsc, `npm test` 92 files / 834 tests
  on the U18 PR.

**Evidence (2026-08-23, `Emuthmartinez/platform`):**

- [PR #5](https://github.com/Emuthmartinez/platform/pull/5) ports the same
  stamps. The clone still uses the unpartitioned `cached(key, ttl, fn)`
  API (U20 process-cache partition is not on this clone). `crud-factory`
  passes `req` so resources can stamp. Isolation: `ENABLE_PLATFORM_DEPLOYS`
  unset; merge must run CI only.

**Not claimed:**

- Queue v2 producers
- Merge Colombia `staging` to `main`

### U8 — Colombia backfill (KTD6 step 3)

| Field | Value |
|---|---|
| Requirements | R6, R7 |
| KTDs | KTD6 |
| Depends on | U7, U18 |
| Status | staging incident-domain backfill applied; tighten on `feat/platform-u8-tighten`
| Rollback | columns stay nullable. Dual-write keeps stamping new rows. Progress table `ops_backfill_progress` is operational, not a Drizzle migration. |
| PR/commit | runner expansion on `feat/platform-u8-domains` (this PR). First reports slice: [PR #74](https://github.com/mallanet/Terremotocolombia/pull/74) `733ff79` |

**Evidence (2026-08-23, Colombia staging Neon `br-shy-king-ax96do57`):**

- Direct host `ep-spring-credit-ax8bptqt.c-4.us-east-2.aws.neon.tech`
  (pooler suffix stripped). Production branch
  `br-nameless-dew-axx1c59w` was not opened.
- Operator `Emuthmartinez`. Confirm token `colombia-u8-backfill`.
- Expanded manifest checksum
  `8db8c7f959ca54ada60a0c039e47fb50863d6375eb7ac0f2131b9a8e6f8db60f`.
- Count-only then apply, one domain at a time. `ops_backfill_progress`:
  50 rows, all `complete` (reports 6 + remaining 44).
- Rows stamped on apply: `volunteers` 3; `missing_person_suppressions` 11;
  `missing_persons` 1; `missing_pets` 1; `person_cluster_members` 6;
  `person_clusters` 3; `person_link_decisions` 6; `person_links` 3;
  `person_records` 12; `record_status_signals` 2; `api_keys` 1;
  `click_counters` 1; `click_counter_dedup` 1. Other listed tables were
  already empty or already scoped (`unscopedAfter=0`).
- Post-apply verification: zero NULL `organization_id`/`incident_id` on
  reports, volunteers, hospitals, family-search, hub, ops, and campaign
  tables. `audit_log` still has 113 unscoped rows (mixed-scope; out of
  this runner).

**Evidence (2026-08-23, worktree):**

- Manifest domains: `reports`, `volunteers`, `hospitals`,
  `family-search`, `hub`, `ops`, `campaign`. Catalog tables and
  `audit_log` are absent.
- Non-`id` PKs: `report_confirmations (report_id, ip_hash)`,
  `missing_person_suppressions.legacy_id`, `person_records.prn`,
  `hub_sync_state.type`, `click_counters.key`,
  `click_counter_dedup (counter_key, ip_hash)`.
- Direct-endpoint wrapper: `scripts/ops-backfill-direct.sh`.
- Tests: `backend/test/ops-backfill.test.ts` 17 passed against local
  Postgres.

**Not claimed:**

- Apply on Colombia production Neon
- Merge Colombia `staging` to `main`

### U8 — Colombia tighten (KTD6 steps 4-6)

| Field | Value |
|---|---|
| Requirements | R6, R7 |
| KTDs | KTD6 |
| Depends on | U8 backfill |
| Status | applied on Colombia staging Neon and isolated platform Neon; code PR next |
| Rollback | columns stay NOT NULL. Revert Worker/code. Do not drop NOT NULL in the compatibility window. |
| PR/commit | `feat/platform-u8-tighten` (this branch). Sub-plan: `docs/plans/2026-08-24-001-impl-u8-tighten.md` |

**Evidence (2026-08-24, local Postgres `localhost:5432/app`):**

- `0024_tenant_tighten.sql` applied. `verify-tighten.sql`: 50/50 tables
  `org_not_null=true` and `incident_not_null=true`.
- `npm run check:platform-schema` OK (TCP `pg`). Journal SHA256
  `454474225141a6a4e9410b9ac108e4f6638f404a7ec65635ab6453b55a9cdb87`.
- Backend vitest: 94 files, 865 passed. Lint and typecheck clean.
- Unscoped insert into `reports` without tenant columns fails not-null.
- `audit_log` stays nullable (mixed-scope).
- Schema declares `{table}_tenant_scope_idx` next to ownership FKs except
  `audit_log`.

**Evidence (2026-08-24, Colombia staging Neon `br-shy-king-ax96do57`):**

- Direct host `ep-spring-credit-ax8bptqt.c-4.us-east-2.aws.neon.tech`.
  Production branch `br-nameless-dew-axx1c59w` was not opened.
- Operator `Emuthmartinez`. Confirm token `colombia-u8-tighten`.
- Manifest checksum
  `8db8c7f959ca54ada60a0c039e47fb50863d6375eb7ac0f2131b9a8e6f8db60f`.
- Count-only then apply, one domain at a time: reports, volunteers,
  hospitals, family-search, hub, ops, campaign. Every `unscoped` value
  was 0. Runner left columns nullable, FKs validated, tenant indexes
  `indisvalid=true`.
- Then `scripts/migrate-direct.sh` applied `0024_tenant_tighten.sql`.
- `check:platform-schema` OK: NOT NULL + validated FKs + tenant indexes.

**Evidence (2026-08-24, isolated Neon `hidden-cell-49890973` / `br-sparkling-unit-ay5figxy`):**

- Direct host `ep-fancy-hill-ayed6nze.c-5.us-east-2.aws.neon.tech`.
- Same count-only / apply / migrate sequence. `check:platform-schema` OK.

**Not claimed:**

- `audit_log` mixed-scope classifier
- Apply on Colombia production Neon
- Merge Colombia `staging` to `main`

## Blocker packets (open)

### B0. Production promotion dry-run (U0 verification)

- **Missing:** explicit approval to run `promote-*` / backend promote against
  production with no intended user-facing change.
- **Why:** CLAUDE.md forbids production deploys, DNS, and secret changes on
  agent initiative. The parent U0 verification asks for one dry run.
- **Prepared:** upload/promote workflows, domain-smoke, release-record template.
- **Risk if skipped:** mechanism is tested in unit tests and staging after
  merge; production identity wiring is proven only at first real promote.
- **First command after approval:**
  `gh workflow run deploy-frontend.yml --ref main` then
  `gh workflow run promote-frontend.yml -f source_sha=<that SHA>`
  (operator confirms served SHA, then rolls back if this was only a drill).

### B1. GitHub Environment required reviewers (U0 optional-stronger)

- **Missing:** maintainer configures `production-frontend`, `production-admin`,
  `production-backend` with required reviewers.
- **Why:** KTD17 wants environment approval. Dispatch is the interim human gate.
- **Prepared:** workflows already declare those environment names.
- **First action:** GitHub → Settings → Environments → required reviewers.

### B2. Platform repository org home

- **Interim:** https://github.com/Emuthmartinez/platform exists and is isolated.
- **Missing:** an org owner creates or transfers `mallanet/platform`.
- **Do not** copy Colombia `DOPPLER_TOKEN` / Cloudflare tokens onto the clone.
- **Do not** set `ENABLE_PLATFORM_DEPLOYS` until isolated Workers exist.
