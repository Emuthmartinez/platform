# Isolated platform secrets and database

Colombia production stays on Doppler project `terremotocolombia-web` and
Neon project `cool-sea-70146941`. This clone uses a separate pair.

| Resource          | Value                                                                   |
| ----------------- | ----------------------------------------------------------------------- |
| Doppler workplace | Furbo (CLI default on this machine)                                     |
| Doppler project   | `mallanet-platform`                                                     |
| Doppler configs   | `stg` and `dev` hold `DATABASE_URL` (direct). `prd` has no database URL |
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

Same Cloudflare account as Colombia. Isolation is the **Worker name**, not
the account. Never deploy this clone with a `terremotocolombia-*` name.

| Worker                            | URL                                                                 |
| --------------------------------- | ------------------------------------------------------------------- |
| `mallanet-platform-api-staging`   | https://mallanet-platform-api-staging.e-muth-martinez.workers.dev   |
| `mallanet-platform-admin-staging` | https://mallanet-platform-admin-staging.e-muth-martinez.workers.dev |
| `mallanet-platform-web-staging`   | https://mallanet-platform-web-staging.e-muth-martinez.workers.dev   |

Staging `workers_dev` is true. Root names exist so `wrangler deploy` without
`--env` cannot overwrite Colombia Workers. Do not add `routes`.

The admin Worker reaches the API through the `EMERGENCY_API` service binding.
Do not replace this with a public Worker-to-Worker fetch. The public URL stays
in `EMERGENCY_API_URL` so local development and request URLs use one contract.

The isolated staging API allows `https://staging.terremotocolombia.co` as a
browser origin. This is the Colombia staging-only bridge to the platform API.
Production Colombia origins and Workers stay unchanged until U21.

Queues: `mallanet-platform-{needs,imports,matcher}[-dlq][-staging]`.
