# Isolated platform secrets and database

Colombia production stays on Doppler project `terremotocolombia-web` and
Neon project `cool-sea-70146941`. This clone uses a separate pair.

| Resource | Value |
| --- | --- |
| Doppler workplace | Furbo (CLI default on this machine) |
| Doppler project | `mallanet-platform` |
| Doppler configs | `stg` and `dev` hold `DATABASE_URL` (direct). `prd` has no database URL |
| Neon org | `org-wandering-hill-20323267` (Mallanet) |
| Neon project | `hidden-cell-49890973` (`mallanet-platform`) |
| Neon branch | `main` (`br-sparkling-unit-ay5figxy`) |
| Data | Empty schema from clone migrations. No crisis rows |

`doppler.yaml` in the repo root selects `mallanet-platform` / `stg`.

Apply migrations (direct URL, never the pooler):

```bash
cd backend
MIGRATIONS_DIR=../infra/db/migrations doppler run -- npx tsx worker/migrate.ts
```

Do not copy Colombia `DOPPLER_TOKEN` or Cloudflare tokens into
`Emuthmartinez/platform`. Do not set `ENABLE_PLATFORM_DEPLOYS`.
