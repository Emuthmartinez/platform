# Operational schema runners (U8)

These runners change data. They are not Drizzle migrations.

`backend/worker/migrate.ts` wraps each SQL file in one transaction. It
also sets `lock_timeout` to 3s and `statement_timeout` to 60s. A batched
backfill loop cannot live in that path. `CREATE INDEX CONCURRENTLY`
cannot live in that path.

This directory holds checksummed manifests, verification SQL, and the
operator notes. The Node runner is `backend/worker/ops-backfill.ts`.
It does not call `seedAuth()`.

## Safety

- An agent never runs this runner against staging or production Neon.
- Use the Neon **direct** endpoint. Never use `-pooler`.
- Run **one domain** at a time.
- Run `--mode count-only` first. Read the counts. Then run `--mode apply`.
- This slice does **not** set columns to `NOT NULL`. That is a later
  migration after a human confirms zero NULL rows on staging.

## Reports domain (first slice)

Target IDs: `org_mallanet` / `inc_terremoto_colombia_2026`.

Tables: `analytics_events`, `chat_messages`, `contact_messages`,
`damage_candidates`, `report_confirmations`, `reports`.

Local:

```bash
cd backend
npm run ops:backfill -- --domain reports --mode count-only
npm run ops:backfill -- --domain reports --mode apply
```

Staging (human, Doppler `stg`, direct URL, not pooler):

```bash
cd backend
doppler run --project terremotocolombia-web --config stg -- \
  npm run ops:backfill -- --domain reports --mode count-only
doppler run --project terremotocolombia-web --config stg -- \
  npm run ops:backfill -- --domain reports --mode apply \
  --confirm colombia-u8-backfill --operator your-handle
```

After apply, run `verify-reports-domain.sql`. Every `null_rows` value
must be 0. Record the printed manifest checksum and operator in the
execution ledger **after** that evidence exists.

Do not start `audit_log` or `api_keys` from this runner yet.
Do not start the SET NOT NULL tighten from this runner.
