# Platform clone notes

This directory records how this repository relates to Colombia production.

| File | Purpose |
| --- | --- |
| `colombia-upstream.json` | Immutable clone source (URL, SHA, fetch time) |
| `colombia-sync-ledger.md` | Created in U19; one row per imported Colombia `main` commit |
| `rls-feasibility.md` | KTD5 probe evidence (U6) |

## Isolation

- GitHub Actions deploy, schema-drift monitor, and verify-jobs workflows
  require repository variable `ENABLE_PLATFORM_DEPLOYS=true`.
- Do not copy Colombia Doppler `prd` / `stg` tokens into this repository.
- Do not attach this clone to `terremotocolombia.co` Workers, DNS, or WAF.
- `config/deployment.config.json` still names Colombia domains. That is the
  snapshot identity. Extra keys are not allowed (frontend loader is closed).
  Isolated staging identity comes later, when U9 / U20 create platform
  Workers.

## Verification this unit cannot claim yet

U6's plan asks for platform CI including the OpenAPI gate, and a staging
deploy from the platform repo. Those are false on this SHA:

- OpenAPI oasdiff lives on Colombia **staging** (U16), not Colombia `main`.
- A staging deploy from this clone would hit Colombia staging Workers.
  That is forbidden until isolated platform staging exists.

Record those gaps. Do not merge Colombia `staging` into this `main` to
fake them.
