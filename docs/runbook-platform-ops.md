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
- The staging deployment catalog maps `api-staging.mallanet.org` to the
  Colombia staging organization and incident. Add this alias through the
  authenticated deployment-management API; do not add a tenant fallback in
  code.
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

The scoped Mockraw deployment token lives in Doppler as
`CLOUDFLARE_API_TOKEN`: `mallanet-platform/stg` for staging and
`mallanet-platform/prd` for production. GitHub stores only the corresponding
narrow Doppler service tokens (`DOPPLER_TOKEN_STAGING` and `DOPPLER_TOKEN`),
and each deploy runs Wrangler through `doppler run`. Do not store a Cloudflare
API token directly in GitHub. Keep the token scoped to Workers edit on only the
Mockraw account; do not pass unrelated application secrets to Wrangler.

## First operator bootstrap

Platform identity is intentionally independent from deployment users and
`users.is_super_admin`. Apply migrations through `0027` first, then run the
following command through the staging secret provider with a direct database
URL:

```bash
cd backend
npm run ops:ensure-platform-operator
```

The command requires `PLATFORM_OPERATOR_EMAIL`, `PLATFORM_OPERATOR_NAME`, and
`PLATFORM_OPERATOR_PASSWORD`. It creates a missing operator and idempotently
ensures the full bootstrap capability set. It never copies a deployment user
automatically. After Google Access is accepted, new operators are pre-provisioned
from the portal with their exact capability grants; no Google or Access domain
membership creates an operator.

At least two active operators are required for a provisioning run: the creator
cannot approve their own plan, and the approving operator cannot apply it.

## Google and Cloudflare Access

Production and staging use separate Cloudflare Access applications and separate
Google OAuth web clients. They may share the Zero Trust team domain
`mallanet-platform.cloudflareaccess.com`, but each application has a distinct
AUD and each Google client has its own secret and redirect registration.

For each tier:

1. Create a Google OAuth web client. Set the authorized JavaScript origin to
   `https://mallanet-platform.cloudflareaccess.com` and redirect URI to
   `https://mallanet-platform.cloudflareaccess.com/cdn-cgi/access/callback`.
2. Add that client as a distinct Google identity provider in Cloudflare Zero
   Trust.
3. Create a self-hosted Access application for the exact portal hostname. Use
   an explicit email allowlist policy; Access is deny-by-default.
4. Add a path-specific bypass application for only `/api/health`, so deployment
   readiness remains machine-verifiable without an operator session.
5. Store that application's AUD as `PLATFORM_ACCESS_AUD` on only the matching
   platform API Worker. Keep `PLATFORM_AUTH_MODE=cloudflare_access` and the team
   domain configured as non-secret Worker vars.
6. Pre-provision the same email as a platform operator with explicit scopes.
   Complete a real Google sign-in and verify that the subject becomes linked.

Never use the staging AUD, Google client, operator database, or platform session
secret in production. Never authorize the `mockraw.workers.dev` rollback origin
as a portal; the backend assertion exchange prevents that origin from becoming
an alternate login path.

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

After the migration, Access provider configuration, and operator bootstrap are
explicitly approved and run,
deploy the staging API first, then `ops/`. Verify `/api/readyz`, the ops
`/api/health`, operator login, portfolio readback, self-approval rejection, and
a synthetic `example.org` preview plan. Do not use a Colombia or Venezuela
hostname for the synthetic run.
