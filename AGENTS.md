# AGENTS.md

This is the operating guide for code agents (and humans) who work in this
repository: the **Mallanet multi-incident platform** clone (U6). The live
Colombia deployment remains
[mallanet/Terremotocolombia](https://github.com/mallanet/Terremotocolombia)
until cutover unit U21.

The project began as a generic template, and most of the code still is
generic. The clone identity in `config/deployment.config.json` still names
Colombia hostnames. That is the source snapshot. It is **not** permission
to deploy those hostnames from this repository.

> **`CLAUDE.md` and `AGENTS.md` are two separate files, on purpose. Do not
> merge them, and do not turn one into a symlink of the other.**
>
> `CLAUDE.md` holds what an agent needs to know **before** touching
> anything: this clone does not deploy Colombia; promotion and secrets stay
> human-gated; Colombia production stays on the original repo until U21.
>
> The split: **`CLAUDE.md` governs deployment and operational security**.
> **This file governs code conventions.**

## Two-repo drift (KD1)

Colombia `main` can still change while this repo is the platform home.
U19 owns the one-way import. Do not merge Colombia `staging` into this
`main` to “catch up” Phase A. Import only from Colombia `origin/main`
after those commits land there. Record each import in
`docs/platform/colombia-sync-ledger.md` when that file exists.

Backport a platform fix to Colombia only when Colombia production needs it
before U21. Keep the backport small. Do not grow a second long-lived
feature branch in Colombia for platform work.

## Before you touch code

- Read this file, `CONTRIBUTING.md`, and the code you plan to change, before
  you write anything.
- If your change touches architecture, sync, data, public endpoints,
  workers, or deployment, also read `docs/architecture.md` and update it in
  the same change (see "Architecture rule" below).
- If your change touches public UI, styles, layout, visual components, or
  experience copy, read `docs/DESIGN.md` first, and keep its tokens and
  criteria as the visual source of truth.
- Work on a branch with a descriptive name. Make changes that are small,
  reviewable, and have a clear reason: keeping the project running matters
  more than a broad refactor.
- Do not rewrite history, delete branches you do not own, or revert changes
  you did not make.
- **A merge to `main` in this clone does not deploy Colombia.** Deploy
  workflows stay skipped unless `ENABLE_PLATFORM_DEPLOYS` is `true` after
  isolated staging exists. Colombia production still releases from
  `mallanet/Terremotocolombia` until U21. For the full rules: `CLAUDE.md`.

## Architecture rule

If you change the system's real architecture, update the documentation in
the same change:

- Update `docs/architecture.md` in the same change.
- If a rule that agents must follow changes, update this file.
- If you add environment variables, update `.env.example` (correct group,
  mark `[REQ]`/`[OPT]`, and use an obviously fake placeholder value).
- If you add or change a domain, port, or service, update
  `docker-compose.yml`, `docker-compose.prod.yml`, and `Caddyfile.example`
  at the same time as the code that needs it.
- **And what governs production today, which compose does not cover:**
  - `frontend/wrangler.jsonc` / `backend/wrangler.jsonc` — bindings, vars,
    `compatibility_flags`, bundling aliases.
  - `frontend/open-next.config.ts` — the Next → Workers adapter.
  - `.github/workflows/deploy-*.yml` — path filters and smoke checks.
  - The **external** OpenTofu module (`~/Colombia/infra/cloudflare`), if DNS,
    WAF, cache, or the zone's rate limit changes.

  A change that only touches `docker-compose*.yml` **does not reach
  production**.

## Security and privacy (hard invariants)

A project of this kind handles data about people in crisis. GitHub is
public. It must **never** serve as an emergency channel or as a database of
affected people.

- **Never hardcode a real identity in application code.** No domain, IP
  address, email, phone number, organization/event name, sensitive
  coordinate, or real handle goes in `frontend/`, `backend/`, `admin/`,
  fixtures, or tests. Use `example.org`, environment variables, or values
  read from `config/deployment.config.json`.

  **Expected exception — do not "fix" this:** deployment files **do**
  carry real names on purpose, because they describe *this* installation,
  not a template:

  ```text
  config/deployment.config.json      terremotocolombia.co, Mallanet.org
  frontend/wrangler.jsonc            terremotocolombia-web + owned domains
  backend/wrangler.jsonc             terremotocolombia-api
  .github/workflows/deploy-*.yml     Worker names and smoke-check URLs
  .neon                              Neon org and project
  ```

  Replacing these with placeholders breaks the deployment. This rule
  protects **application code**, not infrastructure configuration.
- **Never invent or load real data about people.** For examples, tests, and
  fixtures, use synthetic data, clearly marked as demo data. Never publish,
  in code, issues, PRs, or screenshots: phone numbers, personal emails,
  identity documents, full private addresses, medical notes, private
  photos, or hashes of real photos.
- **Every API route needs rate limiting and validation.** This is a hard
  invariant, **enforced by ESLint** (`backend/eslint-rules/`, runs in
  `npm run lint` and in CI):
  - `require-rate-limit`: every route declares
    `rateLimit({ scope, limit })`, with no exception by comment.
  - `user-facing-mutation-needs-guard`: every mutation (POST/PUT/PATCH/
    DELETE) under `src/routes/*` carries `requireHuman` (Turnstile) or a
    gate (`requireAdmin` / `requireCapability` / `requireCron` /
    `requireSupplyWrite`). Document a legitimate anonymous exception with
    `// eslint-disable-next-line local/user-facing-mutation-needs-guard --
    reason`.
  - `no-turnstile-in-public-api`: `src/public-api/*` (the
    capability-authenticated surface) carries **no** Turnstile — it does
    not serve browser traffic.
  - Every public input validates with Zod, on the server. Do not trust
    client-only validation.
- **Never commit a secret.** `.env`, `.prod.env`, database dumps,
  credentials, and tokens do not go in the repository (`.gitignore` already
  covers them). When you add a new secret, document its placeholder in
  `.env.example`, never its real value.
- **Never serialize a full input object into a public response.** Expose
  only the fields you intend to expose.
- If you find a real vulnerability or a data leak, do not open a public
  issue. Report it through your fork's or organization's private security
  channel — for example, GitHub Security Advisories.

## Current state of the stack

No root `package.json` exists. This is a simple monorepo with three npm
packages and a shared infrastructure layer:

- `frontend/`: Next.js + React. Public UI and SSR. It does not access the
  database directly, and it does not add its own `app/api/**` routes — every
  HTTP call goes through `frontend/lib/api.ts`, `frontend/lib/server-api.ts`,
  or a hook.
- `backend/`: Express + TypeScript. Serves the entire `/api` surface,
  validates its environment at startup (fail-fast), uses Drizzle over
  Postgres, and reuses one image for the API, the worker, and migrations.
- `backend/worker/`: BullMQ workers (external-source sync, geocoding,
  deduplication, hub federation, migrations/backfills) running over Valkey.
- `admin/`: the admin panel, a standalone Next.js microservice
  (role-based access with a JWT in an httpOnly cookie). Its BFF (`app/api/*`)
  forwards to the backend over the internal network — it does not serve
  public traffic.
- `infra/db/`: the Drizzle schema (`schema.ts`, the source of truth) and
  versioned migrations.
- `config/deployment.config.json`: the deployment's identity (name,
  domains, map center, language, contact). Read from here before you
  hardcode any branding value.

### Deployment: two paths, and the second one runs today

1. **A VPS with `docker-compose.prod.yml` plus Caddy**
   (`Caddyfile.example`). This is the path `docs/deploy-vps.md` describes,
   and the only one where **the whole system** works: BullMQ/Valkey queues,
   interactive Postgres transactions, and the `admin/` panel.
2. **Cloudflare Workers** — *what serves terremotocolombia.co right now.*
   The frontend (`terremotocolombia-web`) runs on
   `@opennextjs/cloudflare`, and the API (`terremotocolombia-api`) wraps the
   same Express app with `httpServerHandler`, against **external Neon
   Postgres**. On this path, **no** queues and **no** interactive
   transactions exist. `admin/` still runs here too — see `CLAUDE.md`.

Before you assume where something runs, check `CLAUDE.md` → "Where this
actually runs." For local development, `docker compose` stays the
convenient path, because it starts Postgres and Valkey for you.

**Production secrets live in Doppler** (`terremotocolombia-web` / `prd`),
not in `.env`. Any command that needs real credentials runs through
`doppler run -- …`.

## Useful commands

Frontend:

```bash
cd frontend
npm install
npm run dev
npm run lint
npm run typecheck
npm run build
npm test
```

Backend/API/worker:

```bash
cd backend
npm install
npm run dev
npm run typecheck
npm run build
npx tsc --noEmit -p worker/tsconfig.json
```

Admin:

```bash
cd admin
npm install
npm run dev
npm run lint
npm run typecheck
npm run build
```

Full local stack (the preferred path):

```bash
docker compose up --build
docker compose down
```

This exposes `frontend` on `:3000`, `admin` on `:3001`, `backend` on
`:8080`, Postgres on `:5432`, and Valkey on `:6379`.

Database:

```bash
cd backend
npm run db:generate
npm run migrate
```

> `npm run migrate` runs against the **local/compose** database only. No
> automatic gate exists in production, and CI does not run migrations
> there: they are a manual step against Neon **direct** (not the `-pooler`
> endpoint), and an agent never runs them on its own initiative. See
> "Schema order" below and `docs/architecture.md` → "Data and migrations."

## Implementation conventions

- Keep input validation on the server. Do not trust client-only
  validation.
- Return error responses that are visible and actionable. Do not silence a
  failure, and do not return success when a write did not save.
- Avoid `as any`, unnecessary casts, and duplicate helpers. Check first
  whether a function already exists in `frontend/lib/`,
  `backend/src/lib/`, or `backend/src/middleware/`.
- Keep existing rate-limit, cache, and payload-size limits, unless the PR
  explains the operational risk.
- For public contract changes, update the route's `@swagger` block and the
  matching OpenAPI artifact.
- For long-running or third-party work (sync, geocoding, scrapers,
  backfills, external AI/API calls), queue it through the job-dispatch
  seam described in "Background jobs" below, and return a status you can
  poll. Do not block the request path on it.

### Backend endpoints (ESLint rules, gated in CI)

The backend has TWO HTTP surfaces, and each one follows its own pattern:

- **`src/public-api/*` — the authenticated surface (integrations and
  admin).** It is **deny-by-default**: every route is gated by
  `requireCapability("<resource>:<verb>")`. For a model's CRUD, do not
  write the router by hand: add a `resources/<model>.resource.ts` file
  (config), and let the **factory** (`crud-factory.ts`) mount the router,
  validate input, log the audit trail, and document OpenAPI from that
  config. CRUD capabilities are `read | create | edit | delete`. The fixed
  catalog lives in `src/auth/capabilities.ts` (it seeds the `capabilities`
  table).
- **`src/routes/*` — the public site (anonymous) plus the legacy admin
  surface.** Every mutation carries `requireHuman` (Turnstile) or a gate,
  except for a documented exception (see above).
- **Both surfaces:** every route declares `rateLimit({ scope, limit })`,
  with no exception. Keep `@swagger` on hand-written routes. CRUD-factory
  routers document themselves from their Zod schemas.

### Frontend

- Every HTTP call must go through `frontend/lib/api.ts`,
  `frontend/lib/server-api.ts`, or a hook in `frontend/hooks/`.
- The browser calls the backend through `NEXT_PUBLIC_API_URL`. Do not
  assume `/api` shares an origin with the frontend.
- Public mutations that write sensitive data must get a Cloudflare
  Turnstile token with `useTurnstile()`, and send it as `turnstileToken`
  or `cf-turnstile-token`, matching the existing helper. Turnstile is
  **active** in both environments — a missing token gets a real `403`, not
  a bypass.
- Keep TanStack Query as the client-side cache and dedup layer. Do not
  duplicate a manual fetch when a hook already exists.
- Photo URLs that arrive as relative paths must pass through
  `mediaUrl()`, to anchor them to the backend.

### Backend/API

- Routes live in `backend/src/routes/`. Business logic lives in
  `backend/src/services/`. This simple pattern applies to the project's own
  public site.
- **Third-party integrations** (external APIs projected onto our own
  domain, such as a collection-center directory) go in as DDD modules
  under `backend/src/modules/<domain>/`, not as a plain `service`. Layers
  depend inward: `domain/` (entities, value objects, pure rules, and the
  **port**/interface for the source — no HTTP, no `env`), `application/`
  (use cases), `infrastructure/` (adapters that implement the port: an
  HTTP client, an anti-corruption mapper, a cache decorator),
  `interface/http/` (router, controller, presenter — the only layer that
  knows Express and carries `@swagger`), and `<domain>-module.ts` (the
  composition root — the only place that reads `env` and wires everything
  together). Reference:
  `backend/src/modules/acopio/` and `backend/src/modules/needs/`. Adding
  another source means adding another adapter for the same port. The
  browser never calls a third party directly — the backend always proxies
  the call.
- Every optional third-party integration turns on with its own `ENABLE_*`
  flag in `.env.example` (for example, `ENABLE_RESPONSEGRID`,
  `ENABLE_HUB_FEDERATION`, `ENABLE_PATIENT_OCR`, `ENABLE_EXAMPLE_SOURCE`).
  Every flag starts as `false`: the template must run with no third-party
  integration configured.
- Mount routes with `Router`, `asyncHandler`, `validate()`, and the
  existing middleware (`rateLimit`, `requireHuman`, `requireAdmin`,
  hospital auth) before you write a new helper.
- Public or polled GET routes should use `cached()` and/or
  `jsonWithEtag()`, when the contract allows it.
- A public GET can enter the Worker JSON edge cache only when its path is in
  `lib/json-edge-cache.ts` and its response has an explicit public `s-maxage`.
  Never add an authenticated or user-specific response to that allowlist.
- Never use `*` in CORS. Set `CORS_ORIGINS` to the allowed frontend
  origins.
- When you persist or compare an IP address, use `clientIp()` and
  `hashIp()`. Never store a raw IP.
- Structured application logs use `request_id` and `ip_hash`. Never add a raw
  IP, request body, query value, contact value, or error message that can carry
  PII. Keep every 5xx, and sample routine access logs.
- With no `TURNSTILE_SECRET_KEY`, `requireHuman` turns off, for local
  development. In production, that variable must be set — and today it
  is.

### Data access (Drizzle ORM)

- All ordinary database access goes through Drizzle. Import from
  `backend/src/db` (`getDb`, `hasDbEnv`, `schema`).
- The schema is the source of truth, in `infra/db/schema.ts`. Do not
  create tables at runtime inside the API.
- When you change the schema:
  1. Edit `infra/db/schema.ts`.
  2. Run `cd backend && npm run db:generate`.
  3. Commit the generated `.sql` file and its journal entry, in
     `infra/db/migrations/`.

#### Schema order: the schema goes FIRST, and no deploy applies it for you

In `docker-compose.prod.yml`, the `migrate` service runs before
`backend`/`worker` start. **That is NOT what happens in production
today.** Colombia production runs on Cloudflare Workers from
`mallanet/Terremotocolombia`: a push to that repo's `main` deploys
**code**, and nothing else. This clone does not deploy that production.
A human gates every migration, and neither CI nor any deploy runs one.

This already caused an outage (2026-08-11, commit `a81e17c`): a single
commit carried both a new `.sql` migration and the code that needed it.
Once merged, the new code ran against the old schema. That day cost about
6 hours of `503` errors across every volunteer registration, and lost
roughly 44 sign-ups from people affected by the earthquake.

Rules, in order of importance:

1. **Migrate first, in its own commit, applied before you merge the code
   that uses it.** Code that reads or writes the new columns goes
   **after**, in a separate commit.
   **Operational backfill is not a migration.** `npm run ops:backfill`
   stamps NULL tenant columns in bounded committed batches
   (`backend/worker/ops-backfill.ts`). An agent never runs it against
   Neon. Do not put the loop in `infra/db/migrations/`. The runner must
   not call `seedAuth()`. Use the Neon **direct** endpoint, never
   `-pooler`.
2. **Write expand-contract migrations, always** — not only "when you want
   a rollout with no downtime." Adding a nullable column is backward
   compatible: old code ignores it. A `RENAME COLUMN` is **not**
   backward compatible, and breaks the moment the schema and the code
   disagree — that was the `phone` to `contact` rename on the day of the
   outage. A real expand-contract migration adds `contact` as nullable,
   backfills it, changes the code, and drops `phone` in a later
   migration.
3. **`npm run check:schema-drift`** compares the columns the code expects
   against the columns the database actually has. Run it before you merge
   if you have any doubt. The backend deploy runs it automatically, and
   **refuses to deploy** on drift (`backend/worker/check-schema-drift.ts`).
   To skip it for a hotfix that does not touch those tables: Actions →
   Deploy backend → Run workflow → `omitir_drift`, an audited emergency
   override.
4. **`/api/readyz` does NOT check the schema, and it should not.** A
   pending migration is a legitimate state — that is exactly why the human
   gate exists. Coupling readiness to the schema would turn one table's
   scoped failure into a full outage.

### FORBIDDEN: interactive `db.transaction(...)` in `src/**` (a Workers invariant)

Production runs on Cloudflare Workers, using Neon's HTTP driver, which
**does not support interactive transactions**. A
`db.transaction(async (tx) => …)` call in code the Worker can reach
compiles, passes local tests (node-postgres does support it there), and
**only breaks in production**. Role create/edit in the admin panel broke
exactly this way, with no test catching it.

Instead, use the patterns already in the repository (reference:
`services/patient-imports/apply.ts`, `services/roles.ts`):

- **Conditional claim**: a single atomic
  `UPDATE … WHERE <expected state> RETURNING` statement, in place of
  `SELECT … FOR UPDATE`.
- **Deterministic IDs** for retriable writes: the same input always
  produces the same ID, so a retry hits the same primary key and becomes a
  no-op (`deterministicPatientId`).
- **Compensation** when a later step fails (create a role, then delete it
  if granting capabilities fails).
- **An integrity guard** when two sequential writes must stay consistent
  (the process checks row counts against `totalRows` before it touches
  anything).
- The standard question: if you think you need an interactive
  transaction, ask first whether a conditional `UPDATE` plus idempotency
  can replace it.

`backend/worker/**` (BullMQ, compose only) **can** use interactive
transactions — it runs under Node.

### Background jobs (Cloudflare Queues / Cron Triggers)

A new job does NOT connect to BullMQ directly. It follows the
capability-based seam instead (plan `docs/plans/2026-08-10-002-…`, status in
`docs/runbook-fase0.md`):

1. **Producer**: a Queues binding, when one is registered; BullMQ with
   `VALKEY_URL` otherwise (compose). Reference: `lib/job-dispatch.ts` and the
   `enqueuePatientImport` branch in `lib/queues.ts`. Keep messages at 128 KB
   or less: write anything heavy to the database **before** you queue it,
   never inside the message.
2. **Consumer**: a branch in `lib/queue-consumer.ts` (extracted from
   `worker.ts` so it stays testable), wired into the `queue` handler in
   `src/worker.ts`. Acknowledge PER MESSAGE. On failure, call `retry()`.
   `wrangler.jsonc` configures retries and the DLQ — declare the queue in
   BOTH environments, since `queues` does not inherit into `env.staging`.
3. **Dead letters**: the DLQ's consumer persists each one to `audit_log`
   (`queue.dead_letter`), and acknowledges unconditionally. With no
   consumer on a DLQ, an exhausted message is LOST after 4 days.
   A patient-import DLQ transition must preserve the processor's original
   `error_summary`; do not replace it with the generic retry-exhausted text.
4. **Queues**: run `wrangler queues create <name>` for both production and
   staging, before the first deploy that uses the config.
5. **Verification**: `scripts/verify-jobs.sh [staging|production]` (checks
   derived freshness, writes nothing).

### Updating people lists (hospitalized / sheltered)

Located people — in a hospital or in a shelter/collection center — live in
`hospital_patients`, linked to a place in `hospitals`. They share one table
so a family can find them with a single search, distinguished by:

- `hospitals.facility_type`: `"refugio"` for collection centers and
  shelters; a hospital type for everything else.
- `hospital_patients.status`: `"hospitalized"` or `"sheltered"`.

These are `TEXT` columns, so a new value needs no migration — but you must
add its label in `frontend/lib/hospitals-meta.ts`, so the frontend
displays it correctly.

For bulk loads of real data, use a separate tool, outside the app, that:
always runs dry-run first, deduplicates by unique identifier and name per
place, never auto-merges a conflict, never invents a place or a location,
asks a maintainer for explicit confirmation before it applies anything, and
never writes PII (names, ID numbers, diagnoses) to a repository, an issue,
a PR, or a gist.

## Documentation

- **Write documentation in English, in ASD-STE100 style**: short sentences,
  one meaning per word, active voice, simple tenses. (Changed 2026-08-12
  from Spanish — see the note at the top of `README.md` for why.)
- One deliberate exception: `README.es.md` stays in Spanish. It is the
  public site's Spanish-language landing page for visitors and
  contributors in the region, not internal reference documentation.
- Use Markdown, with reasonably short lines, for readable diffs.
- Current system state goes in `docs/architecture.md`. The design system
  goes in `docs/DESIGN.md`. If the project grows, organize proposals and
  decisions in new subfolders (`docs/rfcs/`, `docs/adr/`), and link them
  from here.
- GEO/SEO for AI search engines: the skill lives in `.claude/skills/geo/`,
  and the guide lives in `docs/geo/README.md`. Audits go to
  `docs/geo/audit-YYYY-MM-DD.md`.

## Quick repo map

```text
frontend/               Next.js UI/SSR, hooks, components, public assets
backend/src/            Express API, services, middleware, Drizzle access
backend/src/modules/    Integrations as DDD modules (domain/application/infra/http)
backend/worker/         BullMQ workers, sync, migrations, and backfills
admin/                  Standalone admin panel (Next.js: BFF app/api/* + RBAC)
infra/db/               Drizzle schema, migrations, operational backfill
config/                 deployment.config.json (deployment identity)
docs/                   Design and architecture
docs/geo/               GEO/SEO audits + how to use the skill
.claude/skills/geo/     Vendored GEO/SEO skill (zubair-trabzada/geo-seo-claude)
.claude/agents/geo-*.md GEO subagent prompts
docker-compose.yml      Local stack (dev)
docker-compose.prod.yml Production stack (single VPS + Caddy)
Caddyfile.example       Caddy config with {$VAR} placeholders
.env.example            Full environment-variable contract
```

## Pull requests

Before you open or update a PR:

- Link the issue that tracks the work, or explain why the change is small
  enough to skip one.
- Include screenshots or video, if the change touches public UI.
- List the commands you ran (`frontend`/`backend`/`admin` lint, typecheck,
  build, manual tests), or explain why one does not apply.
- Describe any impact on privacy, crisis data, performance, cache,
  environment variables, deployment, or migrations.
- Keep the PR focused. If related changes come up, open a separate issue
  for them.

## Code principles

- **YAGNI first.** Before you write new code, ask: does this already exist
  in the repository? Does the standard library, a framework API, or an
  already-installed dependency solve it? Only then, write the minimum code
  that works.
- No abstraction the task did not ask for. No new dependency, when you can
  avoid one. Duplication costs less than the wrong abstraction — do not
  extract a shared helper before the third real repetition.
- Delete more than you add. Simple beats clever. The shortest correct diff
  wins.
- Leave every file cleaner than you found it. Delete dead code when you see
  it.
- Use names that describe, that you can search for, and that you can say
  out loud. No magic numbers or loose strings — use named constants.
- Never silence an exception. Give business errors their own specific
  classes.
- Non-trivial code with no test does not ship. A bug fix needs a
  regression test: one that fails before the fix, and passes after it.
- Before you call anything done: lint clean, typecheck clean, tests green.

### Durability net: `failed_submissions`

The five public forms (volunteers, missing persons, reports, contact, data
suppression) capture the submission into `failed_submissions` when the
main write fails, instead of losing it. `lib/failed-submission.ts` **never
throws**: it runs inside the route's `catch` block, and the user still
gets their `5xx` response.

What it covers, plainly: it covers **one table** breaking (schema drift, a
constraint, a type mismatch). It does **not** cover the whole database
going down — the capture also fails there, and the
`[failed-submission] ... LOST` log line is the only signal you get.

Draining it: `SELECT form, count(*) FROM failed_submissions WHERE
replayed_at IS NULL GROUP BY form`. Replaying a row is a manual step today:
fix the cause, insert the row into its real table, and set
`replayed_at`. **A mailbox nobody empties is data loss with extra steps**
— check this table after every write incident.

`payload` holds personal data on purpose — it is the data you do not want
to lose. PENDING: the Law 1581 data-suppression flow
(`routes/data-deletion.ts`) does not check this table yet.
