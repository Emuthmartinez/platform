# Browser storage registry (U20)

Generated from `frontend/lib/browser-storage-registry.ts`. Do not edit by hand.

Classification:

- **citizen-pii** — names, report drafts, photos on device
- **capability-token** — acopio edit tokens
- **auth** — session tokens. Never migrate between tenants
- **preference** — theme, consent, confirmed IDs, chat role, map view
- **operational** — rescue snapshots/packages, service-worker caches

| id | kind | locator | owner | sensitivity | scope | schemaVersion | migrate | retention | deletion |
|---|---|---|---|---|---|---|---|---|---|
| offline-report-drafts | indexeddb | `emergency-offline / pending-reports` | frontend/lib/offline-queue.ts | citizen-pii | incident inc_terremoto_colombia_2026 | 2 | Dual-read v1 {localId,payload,createdAt}. Write v2 with tenant ids and status verification_required. Keep the database name. | 30 days, then status expired. No auto-delete. | Auto-delete only after confirmed durable POST. Never on 403, validation, or migrate failure. User may export or explicit-delete. |
| rescue-map-snapshot | indexeddb | `terremoto-colombia-rescue-map / snapshots` | frontend/lib/rescue-map-offline.ts | operational | rescue incident colombia-2026-08-10-san-jose-del-palmar | 1 | Do not rename the database. Ignore a snapshot whose incidentId is not the current rescue incident. Do not delete it. | Until replaced by a newer snapshot for the same incident. | Overwrite current snapshot id only. No cross-incident reuse. |
| rescue-map-packages | indexeddb | `terremoto-colombia-rescue-map / packages` | frontend/lib/rescue-map-offline.ts | operational | incidentId + aoiId (colombia-2026-08-10-san-jose-del-palmar) | 1 | Records already store incidentId and aoiId. Filter reads by current rescue incident. Store key remains aoiId until U28. | Until the user removes the package or replaces it. | Explicit remove per AOI. Foreign incident packages stay stored. |
| acopio-edit-tokens | localStorage | `acopio.editTokens:v2:inc_terremoto_colombia_2026` | frontend/lib/acopio-edit-store.ts | capability-token | incident inc_terremoto_colombia_2026 | 2 | Copy acopio.editTokens into the incident key once. Never log token values. Do not copy to another incident. | Until the user clears site data. | Not auto-deleted. Incident namespace isolates tokens. |
| confirmed-report-ids | localStorage | `emergency:confirmed:v2:inc_terremoto_colombia_2026` | frontend/components/features/emergency/index.tsx | preference | incident inc_terremoto_colombia_2026 | 2 | Copy emergency:confirmed into the incident key once. | Until the user clears site data. | Local confirmation set only. Not a server record. |
| chat-display-name | localStorage | `emergency:chatName:v2:inc_terremoto_colombia_2026` | frontend/components/features/chat/ChatPanel.tsx | citizen-pii | incident inc_terremoto_colombia_2026 | 2 | Copy emergency:chatName into the Colombia incident key once. Same-incident only. | Until the user clears site data. | User can change the name. No cross-tenant copy. |
| chat-role | localStorage | `emergency:chatRole:v2:inc_terremoto_colombia_2026` | frontend/components/features/chat/ChatPanel.tsx | preference | incident inc_terremoto_colombia_2026 | 2 | Copy emergency:chatRole into the incident key once. | Until the user clears site data. | User can change the role. |
| rescue-map-view-state | localStorage | `mallanet:rescue-map-view:v1:colombia-2026-08-10-san-jose-del-palmar` | frontend/components/features/rescue-map/RescueMapExperience.tsx | preference | rescue incident colombia-2026-08-10-san-jose-del-palmar | 1 | Copy terremoto-colombia:rescue-map-view:v1 into the incident+AOI namespaced key once. | Until the user clears site data. | View state only. No packages. |
| legacy-admin-session-token | sessionStorage | `emergency:adminToken` | frontend admin login (legacy) | auth | browser tab. Not incident-migrated. | 1 | Do not migrate auth or session tokens between tenants. Leave the key as-is. | Tab lifetime (sessionStorage). | Logout removes the key. Never copy to another incident. |
| theme | localStorage | `terremoto:theme` | frontend/components/layout/ThemeProvider.tsx | preference | browser profile (not incident) | 1 | None. Theme is not tenant data. | Until the user clears site data. | User theme toggle overwrites the value. |
| privacy-consent | localStorage | `disaster-response-privacy-consent-v1` | frontend/components/layout/PrivacyConsentGate.tsx | preference | browser profile (not incident) | 1 | None. Consent is operator-policy, not incident data. | Until the user clears site data. | User must clear site data to reset the gate. |
| service-worker-caches | cache-api | `CacheStorage names prefixed mallanet- plus kept v9 names` | frontend/public/sw.js | operational | epoch + org + incident (inc_terremoto_colombia_2026) | e0 | Keep static-v9 / photos-v9 / api-v9 / html-v9 / rescue-data-v9. New names use prefix mallanet-. Delete only mallanet- names not in KEEP. | Current and previous static namespaces for rollback. | Activate deletes owned prefix names that are not kept. Foreign caches stay. |
