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

1. Core catalog: `organizations`, `incidents`, `deployments` (`0014`)
2. Citizen reports surface (`0015`)
3. Volunteers (`0016`)
4. Hospitals and shelters (`0017`)
5. Family-search slice (`0018`)
6. Hub federation (`0019`)
7. Donations, psychology counters, API keys (`0020`)
8. Mixed-scope `audit_log` (`0021`)
9. Reconstruction campaign, handwritten SQL (`0022`)

Campaign tables stay out of the drizzle-kit schema glob. Organization-scoped
tables keep the existing `org_id` stub. Global tables have no tenant columns.
