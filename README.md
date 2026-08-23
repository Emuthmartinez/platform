# Mallanet platform — development clone

*[Léelo en español](README.es.md)*

This repository is the **multi-incident platform** clone (unit U6). It is
canonical for platform development. It is **not** the Colombia production
release source until cutover unit U21.

Colombia production remains **https://terremotocolombia.co**, released from
[mallanet/Terremotocolombia](https://github.com/mallanet/Terremotocolombia).

This clone started from Colombia `origin/main` SHA
`83b7c1669fda091f092edcb3f470a1e81f5669ba`. See
[`docs/platform/colombia-upstream.json`](docs/platform/colombia-upstream.json).

**Do not add Colombia Doppler or Cloudflare tokens here.** Deploy workflows
are dispatch-only and stay skipped unless repository variable
`ENABLE_PLATFORM_DEPLOYS` is the string `true` after isolated platform
staging exists.

> The application identity in `config/deployment.config.json` still names
> Colombia domains because that is the immutable clone snapshot. Changing
> those values here does not retarget production. Isolated staging Workers
> and Doppler configs come later (U9 / U20). Until then, CI is the only
> GitHub Action that should run.

Live disaster-response site for the **2026 Colombia earthquake**, run by
[Mallanet.org](https://mallanet.org). It is a real-time citizen emergency map
with georeferenced incident reports, a missing-persons + hospital/shelter
directory, a collection-center directory, and an admin panel with role-based
access.

**Colombia production → https://terremotocolombia.co**

Agents and contributors: read [`CLAUDE.md`](CLAUDE.md) first — it covers
where this clone sits relative to Colombia production, and what a human
must always do.

## This clone (not Colombia production)

| | |
| --- | --- |
| Platform repo | https://github.com/Emuthmartinez/platform (interim; intended `mallanet/platform`) |
| Colombia production repo | https://github.com/mallanet/Terremotocolombia |
| Live Colombia site | **https://terremotocolombia.co** |
| Frontend / API / Admin identity in this snapshot | Colombia hostnames in `config/deployment.config.json` |
| Database | Neon Postgres (Colombia project; do not migrate from this clone) |
| Secrets | Do not copy Colombia Doppler `prd` into this repository |
| Admin panel | Colombia production still behind Cloudflare Access |
| Frontend deploys from this clone | **Off** until `ENABLE_PLATFORM_DEPLOYS=true` and isolated Workers exist |
| Admin deploys from this clone | **Off** (same gate) |
| Backend deploys from this clone | **Off** (same gate) |

**This clone's `main` is not Colombia production.** Colombia `main` on
`mallanet/Terremotocolombia` remains the production release source until
U21. Do not treat a merge here as a live deploy.

Not currently deployed: the BullMQ queue worker (its jobs were ported to
Cloudflare Queues and Cron Triggers).

## Who this is for

- Volunteer tech teams and NGOs responding to a specific disaster who need a
  working map + directory site immediately, run by people who are not
  full-time software engineers.
- Orgs that already run disaster-response infrastructure and want a
  documented, scrub-clean base instead of copying a previous event's repo
  (with that event's data, secrets, and assumptions still in it).
- Anyone standing this up with an AI coding agent doing the configuration and
  deploy work, not just the coding.

## The headline: an agent can take this from clone to live deployment

This template ships five [Claude Code](https://claude.com/claude-code) skills
under `.claude/skills/`. Open the repo in an agent that reads `CLAUDE.md`
(Claude Code does this automatically) and ask it to stand up your
deployment. It runs these five skills, in this order:

1. **`disaster-configure`** — writes your organization, disaster, region, map
   center, and domains into `config/deployment.config.json` and the few
   static files that can't read it at runtime (PWA manifest, emergency
   contacts, example event data). Everything else in the app reads from this
   one file.
2. **`disaster-brand`** — applies your colors and logo across
   `docs/DESIGN.md`'s design tokens, the app's CSS variables, the PWA
   manifest, the favicon, and the generated social-preview (OpenGraph/
   Twitter) images.
3. **`disaster-secrets-bootstrap`** — generates every required secret
   (`JWT_SECRET`, `IP_SALT`, database/cache passwords, etc.) with `openssl
   rand` and writes your real `.env`, refusing to finish while any
   `CHANGE_ME` placeholder survives.
4. **`disaster-deploy-vps`** — hardens a fresh Ubuntu VPS (deploy user, UFW,
   fail2ban), installs Docker, brings up `docker-compose.prod.yml` behind
   Caddy with Let's Encrypt TLS on your domains, and runs smoke checks
   (services healthy, TLS issued, a test report goes end-to-end, admin login
   works).
5. **`disaster-content-audit`** — the final gate before you share your fork
   publicly or add contributors: scans the whole tree for the kind of
   literal this template itself was scrubbed of (real IPs, personal emails,
   leftover secrets, a previous event's identity) and refuses to say "clean"
   until it actually is.

Each skill is a `SKILL.md` with exact file paths, verification steps, and
hard stops. An agent doesn't need any tribal knowledge beyond what's in the
repo. The human-readable version of this same path is
[`docs/standup-guide.md`](docs/standup-guide.md); [`docs/deploy-vps.md`](docs/deploy-vps.md)
details the VPS step alone.

## Architecture, in one paragraph

Three Next.js/Express apps behind one reverse proxy. `frontend/` (Next.js +
React + Leaflet) is the public map and directories; it never touches the
database directly, only the API. `backend/` (Express + TypeScript + Drizzle
ORM over Postgres) serves everything under `/api`, plus `backend/worker/`
(BullMQ over Valkey) for background sync, geocoding, deduplication, and
optional hub federation. `admin/` is a separate Next.js microservice. It is a
backend-for-frontend with its own RBAC (JWT in an httpOnly cookie) that talks
to the backend over the internal network, never straight to the database.
The template's **one VPS** path (`docker-compose.prod.yml` + Caddy as the single
TLS-terminating reverse proxy, Postgres and Valkey co-located) is still
supported. It is the only path where queues and interactive transactions all
work. But it is **not** what serves terremotocolombia.co today. This deployment
runs on Cloudflare Workers with Neon Postgres, as the table above says. See
[`docs/architecture.md`](docs/architecture.md) for the full picture.

## Quickstart

With your information ready (org name, disaster/region, domains, real local
emergency numbers — see `docs/standup-guide.md` for the full list), the path
below takes about **30 minutes** of active work. DNS propagation adds more
time on top of that.

1. Click **Use this template** on GitHub and create your own repository from
   it.
2. Clone your new repository.
3. Open it in Claude Code (or another coding agent that reads
   `CLAUDE.md`/`AGENTS.md`).
4. Follow `CLAUDE.md` — it points the agent at the standup skills in the
   order above. Answer the questions it asks (your organization's name, your
   region's real emergency numbers, your domains) as they come up. The
   skills refuse to invent this information for you.

Prefer to do it by hand, or want to see every step before an agent runs it?
Read [`docs/standup-guide.md`](docs/standup-guide.md).

## What this template deliberately does NOT include

- **Real datasets.** Every seed (hospitals, missing persons, emergency
  contacts, the reference earthquake event) is synthetic and obviously
  labeled as an example. There is no shortcut that ships real crisis data —
  you provide your region's real information yourself, deliberately, through
  `disaster-configure`.
- **Kubernetes / multi-node / observability stacks.** The supported path is
  one VPS with docker compose and Caddy. A k3s+OpenTofu path and a
  Prometheus/Loki/Grafana observability stack are reasonable next steps at
  larger scale, but they are future work, not part of this template.
- **An i18n framework.** The UI ships in Spanish (the default language for
  this kind of deployment) as plain JSX strings — there is no next-intl/
  i18next abstraction underneath. Localizing to another language today means
  having your agent edit the copy directly. That is a real cost. We chose
  not to hide it behind a false claim of "multi-language support."

## Safety model

This kind of site collects information about people in crisis. The template
enforces a few things structurally, and asks the deployer to own the rest:

- **Content-audit gate.** `disaster-content-audit` (and `scripts/content-audit/`
  standalone) blocks on any of the literal patterns this repo's own history
  was scrubbed of. The same check that runs before this template's own
  releases runs on every fork that uses it.
- **No-real-data policy.** Seeds and fixtures are synthetic by convention
  (`AGENTS.md` makes this a hard rule for anyone contributing code). Real
  crisis data belongs in your database, never in a commit, an issue, or a
  screenshot.
- **Deployers' PII obligations.** Standing this up means you will collect
  real personal data about people in an emergency. That is a legal and
  ethical responsibility this template cannot discharge for you. See
  [`SECURITY.md`](SECURITY.md) for what it enforces (rate limiting,
  bot-check on public writes, RBAC on the admin surface). It also lists
  what remains yours to decide (retention, access, and eventually
  decommissioning the deployment).

## Credit

Maintained by [mallanet.org](https://mallanet.org). Mallanet built and ran
the production platform during the 2026 Venezuela earthquake response.
Mallanet extracted this template from that platform. Mallanet removed the
parts specific to that event and everything sensitive. Mallanet kept the
parts that make the software work and made them generic. If you use this
template for a real deployment, you're standing on that field experience.

MIT licensed. See [`LICENSE`](LICENSE).
