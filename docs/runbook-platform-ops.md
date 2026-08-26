# Runbook — Mallanet control plane

`ops/` is the global Mallanet operations portal. It is separate from every
deployment's `admin/` panel. A platform operator can see deployment topology
and provisioning state, but the platform API does not expose tenant crisis
records.

## Staging boundary

- API: `https://api-staging.mallanet.org` on `mallanet-platform-api-staging`.
- Portal: `https://platform-staging.mallanet.org` on
  `mallanet-platform-ops-staging`.
- Rollback endpoints: the matching `*.mockraw.workers.dev` URLs; the prior
  `*.e-muth-martinez.workers.dev` staging pair remains available during the
  migration observation window.
- Database: the isolated platform staging Neon branch, using its direct URL
  for migrations.
- Cron: earthquake sync has its own schedule; a second staging-only maintenance
  schedule runs geocoding and person reconciliation with separate job and
  idempotency identities, fitting the account's five-trigger limit.
- Colombia public, API, admin, production, and DNS routes are not changed by
  this workflow.
- Venezuela must not be entered as a real provisioning request until Colombia
  staging has passed acceptance and the operator explicitly starts that work.

## Production routing

- API: `https://api.mallanet.org` on `mallanet-platform-api`.
- Portal: `https://platform.mallanet.org` on `mallanet-platform-ops`.
- Cloudflare account: Mockraw, which owns the `mallanet.org` zone.
- Rollback endpoints: the matching `*.mockraw.workers.dev` URLs.
- Staging uses the same zone-owning account with separate Worker, queue,
  rate-limit, Doppler, and Neon resources. Production and staging use explicit
  account IDs in their Wrangler environment configuration.

Deploy production with the named Mockraw Wrangler profile. Deploy the API
first and verify all three readiness endpoints. Then build and deploy `ops/`
and verify `/api/health` plus a real platform-operator login. Do not disable the
rollback endpoints until the custom-domain deployment has a stable observation
window.

## First operator bootstrap

Platform identity is intentionally independent from deployment users and
`users.is_super_admin`. Apply migrations `0025` and `0026` first, then run the
following command through the staging secret provider with a direct database
URL:

```bash
cd backend
npm run ops:ensure-platform-operator
```

The command requires `PLATFORM_OPERATOR_EMAIL`, `PLATFORM_OPERATOR_NAME`, and
`PLATFORM_OPERATOR_PASSWORD`. It creates a missing operator and makes no change
if the email already exists. It never copies a deployment user automatically.

At least two active operators are required for a provisioning run: the creator
cannot approve their own plan, and the approving operator cannot apply it.

## Provisioning lifecycle

1. **Plan** validates stable keys and a canonical hostname with an explicit
   `preview` or `staging` label.
2. The API stores an ordered plan and SHA-256 digest. Repeating the same request
   reuses the run only while it is still `planned`; later states return a
   conflict instead of misattributing the prior run.
3. A different operator **approves** it.
4. An operator other than the approver **applies** it. Automatic catalog steps
   are idempotent.
5. Apply rejects any hostname already present in the live `deployments` table.
6. The run stops at `waiting_external` for Worker provisioning, DNS, and secret
   installation. The preview specification is not inserted into the live
   hostname resolver.

There is deliberately no public activation endpoint. Do not manually insert a
preview hostname into `deployments` to bypass this boundary.

## Verification before staging deploy

```bash
cd backend
npm run typecheck
npm run lint
npm test

cd ../ops
npm ci
npm run typecheck
npm run lint
npm run build
```

After the migration and operator bootstrap are explicitly approved and run,
deploy the staging API first, then `ops/`. Verify `/api/readyz`, the ops
`/api/health`, operator login, portfolio readback, self-approval rejection, and
a synthetic `example.org` preview plan. Do not use a Colombia or Venezuela
hostname for the synthetic run.
