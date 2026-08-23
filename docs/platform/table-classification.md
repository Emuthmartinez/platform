# Table classification (KTD10)

Reviewed artifact: [`table-classification.json`](./table-classification.json).

CI runs `npm run check:table-classification` in `backend/`. The check
compares Drizzle tables from `infra/db/schema.ts` and
`infra/db/schema-campaign.ts` with this file. A missing, duplicate, or
stale name fails the build.

Scopes:

| Scope | Meaning |
| --- | --- |
| `global` | No tenant columns. Catalog, identity principal, or infrastructure. |
| `organization` | Owned by an organization. Not an incident row. |
| `incident` | Gains nullable `organization_id` + `incident_id` in U7 expand, then KTD14 composite FK. |
| `mixed` | `audit_log` only. Discriminator plus ownership columns. |

`click_counters` / `click_counter_dedup` are incident-scoped so the
psychology counter cannot stay a shared global key.

Do not add a Drizzle table without a classification row in the same change.

U7 expand order (one migration commit per group):

1. Core catalog: `organizations`, `incidents`, `deployments`
2. Later groups add nullable `organization_id` / `incident_id` plus the
   composite FK to `incidents(organization_id, id)`. Campaign tables stay
   in handwritten SQL because they are not in the drizzle-kit schema glob.
