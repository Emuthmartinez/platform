# Isolated platform secrets and database

Colombia production stays on Doppler project `terremotocolombia-web` and
Neon project `cool-sea-70146941`. This clone uses a separate pair.

| Resource          | Value                                                                   |
| ----------------- | ----------------------------------------------------------------------- |
| Doppler workplace | Furbo (CLI default on this machine)                                     |
| Doppler project   | `mallanet-platform`                                                     |
| Doppler configs   | `stg`, `dev`, and `prd` hold isolated Mallanet database configuration   |
| Neon org          | `org-wandering-hill-20323267` (Mallanet)                                |
| Neon project      | `hidden-cell-49890973` (`mallanet-platform`)                            |
| Neon branch       | `main` (`br-sparkling-unit-ay5figxy`)                                   |
| Data              | Empty schema from clone migrations. No crisis rows                      |

`doppler.yaml` in the repo root selects `mallanet-platform` / `stg`.

Apply migrations (direct URL, never the pooler):

```bash
cd backend
MIGRATIONS_DIR=../infra/db/migrations doppler run -- npx tsx worker/migrate.ts
```

U7 core (`0014_platform_core`) through campaign tenant expand (`0022`) are
applied on this isolated branch. Drift is clean.

Do not copy Colombia `DOPPLER_TOKEN` or Cloudflare tokens into
`Emuthmartinez/platform`. Do not set `ENABLE_PLATFORM_DEPLOYS`.

## Isolated Workers

Both platform tiers run in the Mockraw Cloudflare account that owns
`mallanet.org`. They use separate Worker and resource names. Colombia staging
Workers remain in their existing account and call the platform through the
staging custom domain. Never deploy this clone with a
`terremotocolombia-*` name.

| Worker                            | URL                                                                 |
| --------------------------------- | ------------------------------------------------------------------- |
| `mallanet-platform-api`           | https://api.mallanet.org                                            |
| `mallanet-platform-ops`           | https://platform.mallanet.org                                       |
| `mallanet-platform-api-staging`   | https://api-staging.mallanet.org                                    |
| `mallanet-platform-ops-staging`   | https://platform-staging.mallanet.org                               |

Production and staging keep `workers_dev` enabled for bounded rollback and
diagnostics. Production declares the `api.mallanet.org` and
`platform.mallanet.org` custom domains. Staging declares
`api-staging.mallanet.org` and `platform-staging.mallanet.org`. All four
Workers run in the account that owns the zone, while their
`*.mockraw.workers.dev` URLs remain available for rollback. The tier-specific
Wrangler configs and resource names prevent staging traffic, queues, rate
limits, and database secrets from crossing into production.

The ops Worker reaches the API through the `PLATFORM_API` service binding. Do
not replace this with a public Worker-to-Worker fetch. The public URL stays in
`PLATFORM_API_URL` so local development and request URLs use one contract.

The isolated staging API allows `https://staging.terremotocolombia.co` as a
browser origin. This is the Colombia staging-only bridge to the platform API.
Production Colombia origins and Workers stay unchanged until U21.

Queues: `mallanet-platform-{needs,imports,matcher}[-dlq][-staging]`.
