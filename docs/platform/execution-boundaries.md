# Execution-boundary inventory (U18)

Every HTTP, Queue, Cron, BullMQ, seed, backfill, and test-helper entry
point has an owner and a `TenantScope` source. `AsyncLocalStorage` is not
an authorization dependency (KTD13). Callers pass `TenantScope` into
domain writes.

Classification of tables: `docs/platform/table-classification.md`.

## Staging switch (own backend vs previous version)

Colombia staging stays on this repository's Workers. Switch back and
forth by reverting the Worker version or the staging pull request. Do not
point DNS, custom domains, or Worker routes at `Emuthmartinez/platform`.

Dual-write is expand-only:

- `organization_id` / `incident_id` stay nullable until U8.
- A previous Worker version ignores the new columns.
- Queue producers still emit the legacy v1 body (`schemaVersion` absent).
  Consumers keep the U20 Colombia compatibility decoder.

## HTTP — public site (`backend/src/server.ts`)

`resolveTenant` runs on every request except health and OpenAPI. Writers
use `requireTenantScope(req)`.

| Mount | Owner | Context source |
|---|---|---|
| `GET /api/healthz`, `GET /api/readyz` | process | Tenant-exempt |
| `GET /api/openapi.json`, `/api/docs` | process | Tenant-exempt |
| `/api/missing` | `routes/missing.ts` | `requireTenantScope` on create/delete |
| `/api/deceased` | `routes/official-deceased.ts` | Read. Imports use public-api |
| `/api/pets` | `routes/pets.ts` | `requireTenantScope` on create |
| `/api/reports` | `routes/reports*.ts` | `requireTenantScope` on create/edit/confirm |
| `/api/chat` | `routes/chat.ts` | `requireTenantScope` on create |
| `/api/hospitals` | `routes/hospitals.ts` | `requireTenantScope` on hospital/patient/supply writes |
| `/api/earthquakes` | `routes/earthquakes.ts` | Global catalog. No tenant columns |
| `/api/donations` | `routes/donations.ts` | `requireTenantScope` on create |
| `/api/patients` | `routes/patients.ts` | Read search |
| `/api/geocode` | `routes/geocode.ts` | Global `geocode_cache` |
| `/api/geo` | `routes/geo.ts` | Read |
| `/api/acopio` | `modules/acopio/` | Third-party directory. No tenant tables |
| `/api/needs` | `modules/needs/` | `requireTenantScope` on enqueue. Status filtered by incident |
| `/api/stats/psychology-help` | `routes/psychology-help.ts` | `requireTenantScope` on increment |
| `/api/contact` | `routes/contact.ts` | `requireTenantScope` on create |
| `/api/volunteers` | `routes/volunteers.ts` | `requireTenantScope` on create |
| `/api/campaign` | `routes/campaign.ts` | Read |
| `/api/campaign/punto` | `routes/campaign-steward.ts` | `requireTenantScope` on steward writes |
| `/api/campaign` pledges | `routes/campaign-pledges.ts` | `requireTenantScope` on create |
| `/api/donaciones` | donations router | Same as `/api/donations` |
| `/api/voluntariado` | `routes/voluntariado.ts` | `requireTenantScope` on check-in |
| `/api/data-deletion` | `routes/data-deletion.ts` | `requireTenantScope` on create |
| `/api/hub` | `routes/hub.ts` | Read replica. Flag off in this deployment |
| `/api/sync` | `routes/sync.ts` | Admin/cron enqueue. Jobs construct Colombia scope |
| `/api/admin` | `routes/admin.ts` | Legacy admin token. Services default `colombiaTenantScope()` |
| `/api/op` | `routes/op.ts` | `requireTenantScope` for OpenPanel proxy keys. No local tenant table |
| `POST` failed-form capture | `lib/failed-submission.ts` | Same `TenantScope` as the failed writer |

Failed submissions, chat, reports, volunteers, missing persons, pets,
contact, donations, data deletion, campaign pledges/receipts, hospital
rows, and psychology counters stamp `incidentOwnership(scope)` on insert.

## HTTP — public-api / admin BFF (`backend/src/public-api/index.ts`)

The admin panel BFF forwards to this surface. Tenant still comes from the
API hostname, not from the panel cookie.

| Mount | Owner | Context source |
|---|---|---|
| `/api/public/auth` | `routes/auth.ts` | Global login principals / org invitations |
| `/api/public/patient-imports` | `public-api/patient-imports.ts` | `requireTenantScope` on create/retry/apply enqueue |
| `/api/public/deceased-imports` | `official-deceased-imports.ts` | `requireTenantScope` |
| CRUD factory resources | `PUBLIC_RESOURCES` | `requireTenantScope` on create/update/delete that write incident tables |
| `/api/public/hospital-supplies` | `hospital-supplies.router.ts` | `requireTenantScope` |
| `/api/public/volunteer-analytics` | `volunteer-analytics.router.ts` | Read |
| `/api/public/deletion-requests` | `deletion-requests.router.ts` | Organization/incident rows already stamped on create |
| `/api/public/partner-sync` | `partner-sync.router.ts` | `requireTenantScope` into `upsertExternalMissingBatch` |
| `/api/public/person-links` | `person-links.router.ts` | HTTP hostname. Matcher/cluster writers default Colombia until U27 threads matcher fully |
| `/api/public/record-signals` | `record-signals.router.ts` | Create path is partner-sync (scoped). Decision is update |
| `/api/public/users` | `users.router.ts` | Global principals |
| `/api/public/grants` | `grants.router.ts` | Organization |
| `/api/public/audit` | `audit.router.ts` | Read. Writes use `req.tenantScope` or global |
| `/api/public/capabilities` | `capabilities.router.ts` | Global catalog |
| `/api/public/api-keys` | `api-keys.router.ts` | `requireTenantScope` |
| `/api/public/hub-credentials` | `hub-credentials.router.ts` | `requireTenantScope` |
| `/api/public/psychology` | `psychology.router.ts` | Read / access gate |
| `/api/public/volunteers/:id/message` | `volunteers-actions.router.ts` | Side effect, no new tenant row |
| `/api/public/volunteer-tasks` actions | `volunteer-tasks-actions.router.ts` | `requireTenantScope` |

`writeAudit` uses incident ownership when `req.tenantScope` is present.
Otherwise it uses `globalAuditOwnership()`.

## Cloudflare Queues (`backend/src/worker.ts` `queue`)

Exact names: `backend/src/lib/queue-registry.ts`. Decode:
`backend/src/lib/queue-protocol.ts`. Domain: `backend/src/lib/queue-consumer.ts`.

| Kind | Names | Context source | Writer |
|---|---|---|---|
| needs | `terremotocolombia-needs`, `-staging` | v1 body `organizationId`/`incidentId`, else Colombia decoder | Publication is external. Status row is incident-scoped `audit_log` |
| imports | `terremotocolombia-imports`, `-staging` | Same decoder. Header row already stamped on HTTP create | `patient-imports` inherit header scope, else Colombia |
| matcher | `terremotocolombia-matcher`, `-staging` | Same decoder on the still-v1 body | `proposeLink` stamps Colombia during dual-write (U27 threads matcher) |
| needs/imports/matcher DLQ | `*-dlq`, `*-dlq-staging` | Decoded tenant if the body parses; else global audit | `audit_log` (`queue.dead_letter`) |
| unknown | any other name | Global | `audit_log` (`queue.quarantine`) |

Producers (`tenantJobFields`) add org/incident on the v1 body. They do
not set `schemaVersion: 2`.

## Cron Triggers (`backend/src/worker.ts` `scheduled`)

Expressions: `backend/src/services/cron-jobs.ts` (must match
`backend/wrangler.jsonc`).

| Expression | Kind | Scope rule |
|---|---|---|
| `*/5 * * * *` | earthquakes | **Global.** Runs once. Writes `earthquakes` / `sync_state` only |
| `2-59/5 * * * *` | geocode | Enumerate `listCronIncidentScopes()` (Colombia today). Filter scoped tables with `sqlOwnsIncidentOrLegacyNull`. `geocode_cache` stays global |
| `4-59/5 * * * *` | person-reconcile | Same enumerator. Stamps `person_records`. Drains `failed_submissions` with the same predicate. Colombia also claims pre-U18 NULL rows |

An unknown Cron expression is `unhandled`. `persistUnhandledCron` writes
a global `audit_log` row. It is not a silent success.

## BullMQ (compose only — not serving terremotocolombia.co)

| Queue | Owner | Context source |
|---|---|---|
| `patient-imports` | `worker/patientImports.queue.ts` | U20 `requireImportJob`. Domain inherits import-header scope |
| `needs-publication` | `worker/needsPublication.queue.ts` | Same as Cloudflare needs |
| `maintenance` geocode | `worker/maintenance.queue.ts` | Explicit `colombiaTenantScope()` |
| `maintenance` duplicates | `worker/sync/dedup.ts` | Read report. Colombia until a second incident exists |
| `sources-sync` | `worker/sourcesSync.queue.ts` | Idle unless `ENABLE_*` source flags. `upsertExternalMissingBatch` defaults Colombia |
| `earthquakes` | `worker/earthquakes.queue.ts` | Global |
| hub ingest/images | `worker/jobs/hub*.ts` | Idle (`ENABLE_HUB_FEDERATION` off) |
| migrate-tables/photos | `worker/enqueue.ts` | One-time import tooling. Not a production writer |

## Seed, migrate, backfill, tests

| Entry | Owner | Context source |
|---|---|---|
| Local seed | `backend/src/seed/index.ts`, `seed/volunteers-demo.ts` | `incidentOwnership(colombiaTenantScope())`. Refuses production / non-local DB |
| Auth seed | `backend/src/auth/seed.ts` | Global capabilities, org roles, global users |
| `backend/worker/migrate.ts` | schema apply | No operational tenant writes. Human-gated against Neon direct |
| Operational backfill | U8 (not this unit) | Must not start until post-deploy rows show zero NULL tenant columns |
| Test helpers | `backend/test/helpers.ts` | Hostname pin → Colombia `TenantScope`. Extra org/incident fixtures construct `createTenantScope` explicitly |

## Tables with no runtime writer in this deployment

These are incident-scoped in the classification artifact. This unit does
not add writers for them:

- `deployments` — seeded, not written at request time
- `hospital_poc_assignments` — read for supply tokens; no insert in `src/`
- `hub_*` — federation flag off
- `analytics_events`, `damage_candidates`, `unidentified_persons` — hub /
  one-time import tooling or tests only
- `incidents` / `organizations` — catalog, not dual-write targets

`click_counters` keeps its existing primary key. Tenant columns sit
beside that key. Do not treat the key as globally unique after a second
incident exists (U27).

## Verification

- New report / chat / patient-import rows carry Colombia org/incident
  without a backfill (`backend/test/tenant-write.test.ts`).
- Needs job-status lookup under a second incident returns not-found.
- Needs and import producers put org/incident on a still-v1 payload.
- Cron geocode and person-reconcile run per enumerated incident, not
  across all rows.
- A pre-tenant queue body still decodes through the Colombia
  compatibility path.
