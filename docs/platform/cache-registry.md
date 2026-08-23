# Cache registry (U20 browser freeze)

This clone does not yet carry the Colombia process-cache table
(`backend/src/lib/cache.ts` tenant partitions). That slice stays on
Colombia staging until U19 imports it. This file records the browser,
service-worker, and Next surfaces that this unit versions.

Browser durable state: `docs/platform/browser-storage-registry.md`.

| Surface | Partition | Key pattern | Notes |
|---|---|---|---|
| TanStack Query (public) | tenant | `[org, incident, epoch, domain, …]` | Earthquakes: `["g", "earthquakes", …]` |
| TanStack Query (admin) | tenant | same prefix via `scopedQueryKey` | `["auth","me"]` and `["invite", token]` stay unprefixed |
| Next ISR | tenant | tag `incident:{org}:{incident}:{epoch}` | `serverApiGetCached` |
| Service worker | tenant + epoch | `mallanet-e0-{org}-{incident}-{kind}` | Keep `*-v9`. Delete owned prefix only |
| Photo SW cache | tenant | `…-photos` | Bytes stay R2; SW name is tenant-unique |
| Offline drafts | incident | IndexedDB `emergency-offline` v2 | `verification_required`; no delete on 403 |
