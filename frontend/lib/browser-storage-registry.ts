/**
 * Durable browser-state inventory (U20). Codegen writes
 * docs/platform/browser-storage-registry.md from this module.
 * Do not migrate auth or session tokens between tenants.
 */
import {
  COLOMBIA_INCIDENT_ID,
  COLOMBIA_RESCUE_INCIDENT_ID,
} from "@/lib/tenant";

export type BrowserStorageKind =
  | "indexeddb"
  | "localStorage"
  | "sessionStorage"
  | "cache-api";

export type BrowserStorageSensitivity =
  | "citizen-pii"
  | "capability-token"
  | "auth"
  | "preference"
  | "operational";

export interface BrowserStorageEntry {
  id: string;
  kind: BrowserStorageKind;
  /** Database, cache, or storage key as the browser sees it. */
  locator: string;
  owner: string;
  sensitivity: BrowserStorageSensitivity;
  scope: string;
  schemaVersion: string;
  migrate: string;
  retention: string;
  deletion: string;
}

export const ACOPIO_EDIT_TOKENS_LEGACY_KEY = "acopio.editTokens";
export const ACOPIO_EDIT_TOKENS_KEY =
  `acopio.editTokens:v2:${COLOMBIA_INCIDENT_ID}`;

export const CONFIRMED_REPORTS_LEGACY_KEY = "emergency:confirmed";
export const CONFIRMED_REPORTS_KEY =
  `emergency:confirmed:v2:${COLOMBIA_INCIDENT_ID}`;

export const CHAT_NAME_LEGACY_KEY = "emergency:chatName";
export const CHAT_NAME_KEY = `emergency:chatName:v2:${COLOMBIA_INCIDENT_ID}`;
export const CHAT_ROLE_LEGACY_KEY = "emergency:chatRole";
export const CHAT_ROLE_KEY = `emergency:chatRole:v2:${COLOMBIA_INCIDENT_ID}`;

export const RESCUE_VIEW_STATE_LEGACY_KEY =
  "terremoto-colombia:rescue-map-view:v1";
export const RESCUE_VIEW_STATE_KEY =
  `mallanet:rescue-map-view:v1:${COLOMBIA_RESCUE_INCIDENT_ID}`;

export const ADMIN_SESSION_TOKEN_KEY = "emergency:adminToken";
export const THEME_STORAGE_KEY = "terremoto:theme";
export const PRIVACY_CONSENT_STORAGE_KEY =
  "disaster-response-privacy-consent-v1";
export const OFFLINE_REPORTS_DB = "emergency-offline";
export const RESCUE_MAP_DB = "terremoto-colombia-rescue-map";

export const BROWSER_STORAGE_REGISTRY: readonly BrowserStorageEntry[] = [
  {
    id: "offline-report-drafts",
    kind: "indexeddb",
    locator: `${OFFLINE_REPORTS_DB} / pending-reports`,
    owner: "frontend/lib/offline-queue.ts",
    sensitivity: "citizen-pii",
    scope: `incident ${COLOMBIA_INCIDENT_ID}`,
    schemaVersion: "2",
    migrate:
      "Dual-read v1 {localId,payload,createdAt}. Write v2 with tenant ids and status verification_required. Keep the database name.",
    retention: "30 days, then status expired. No auto-delete.",
    deletion:
      "Auto-delete only after confirmed durable POST. Never on 403, validation, or migrate failure. User may export or explicit-delete.",
  },
  {
    id: "rescue-map-snapshot",
    kind: "indexeddb",
    locator: `${RESCUE_MAP_DB} / snapshots`,
    owner: "frontend/lib/rescue-map-offline.ts",
    sensitivity: "operational",
    scope: `rescue incident ${COLOMBIA_RESCUE_INCIDENT_ID}`,
    schemaVersion: "1",
    migrate:
      "Do not rename the database. Ignore a snapshot whose incidentId is not the current rescue incident. Do not delete it.",
    retention: "Until replaced by a newer snapshot for the same incident.",
    deletion: "Overwrite current snapshot id only. No cross-incident reuse.",
  },
  {
    id: "rescue-map-packages",
    kind: "indexeddb",
    locator: `${RESCUE_MAP_DB} / packages`,
    owner: "frontend/lib/rescue-map-offline.ts",
    sensitivity: "operational",
    scope: `incidentId + aoiId (${COLOMBIA_RESCUE_INCIDENT_ID})`,
    schemaVersion: "1",
    migrate:
      "Records already store incidentId and aoiId. Filter reads by current rescue incident. Store key remains aoiId until U28.",
    retention: "Until the user removes the package or replaces it.",
    deletion: "Explicit remove per AOI. Foreign incident packages stay stored.",
  },
  {
    id: "acopio-edit-tokens",
    kind: "localStorage",
    locator: ACOPIO_EDIT_TOKENS_KEY,
    owner: "frontend/lib/acopio-edit-store.ts",
    sensitivity: "capability-token",
    scope: `incident ${COLOMBIA_INCIDENT_ID}`,
    schemaVersion: "2",
    migrate:
      "Copy acopio.editTokens into the incident key once. Never log token values. Do not copy to another incident.",
    retention: "Until the user clears site data.",
    deletion: "Not auto-deleted. Incident namespace isolates tokens.",
  },
  {
    id: "confirmed-report-ids",
    kind: "localStorage",
    locator: CONFIRMED_REPORTS_KEY,
    owner: "frontend/components/features/emergency/index.tsx",
    sensitivity: "preference",
    scope: `incident ${COLOMBIA_INCIDENT_ID}`,
    schemaVersion: "2",
    migrate: "Copy emergency:confirmed into the incident key once.",
    retention: "Until the user clears site data.",
    deletion: "Local confirmation set only. Not a server record.",
  },
  {
    id: "chat-display-name",
    kind: "localStorage",
    locator: CHAT_NAME_KEY,
    owner: "frontend/components/features/chat/ChatPanel.tsx",
    sensitivity: "citizen-pii",
    scope: `incident ${COLOMBIA_INCIDENT_ID}`,
    schemaVersion: "2",
    migrate:
      "Copy emergency:chatName into the Colombia incident key once. Same-incident only.",
    retention: "Until the user clears site data.",
    deletion: "User can change the name. No cross-tenant copy.",
  },
  {
    id: "chat-role",
    kind: "localStorage",
    locator: CHAT_ROLE_KEY,
    owner: "frontend/components/features/chat/ChatPanel.tsx",
    sensitivity: "preference",
    scope: `incident ${COLOMBIA_INCIDENT_ID}`,
    schemaVersion: "2",
    migrate: "Copy emergency:chatRole into the incident key once.",
    retention: "Until the user clears site data.",
    deletion: "User can change the role.",
  },
  {
    id: "rescue-map-view-state",
    kind: "localStorage",
    locator: RESCUE_VIEW_STATE_KEY,
    owner: "frontend/components/features/rescue-map/RescueMapExperience.tsx",
    sensitivity: "preference",
    scope: `rescue incident ${COLOMBIA_RESCUE_INCIDENT_ID}`,
    schemaVersion: "1",
    migrate:
      "Copy terremoto-colombia:rescue-map-view:v1 into the incident+AOI namespaced key once.",
    retention: "Until the user clears site data.",
    deletion: "View state only. No packages.",
  },
  {
    id: "legacy-admin-session-token",
    kind: "sessionStorage",
    locator: ADMIN_SESSION_TOKEN_KEY,
    owner: "frontend admin login (legacy)",
    sensitivity: "auth",
    scope: "browser tab. Not incident-migrated.",
    schemaVersion: "1",
    migrate:
      "Do not migrate auth or session tokens between tenants. Leave the key as-is.",
    retention: "Tab lifetime (sessionStorage).",
    deletion: "Logout removes the key. Never copy to another incident.",
  },
  {
    id: "theme",
    kind: "localStorage",
    locator: THEME_STORAGE_KEY,
    owner: "frontend/components/layout/ThemeProvider.tsx",
    sensitivity: "preference",
    scope: "browser profile (not incident)",
    schemaVersion: "1",
    migrate: "None. Theme is not tenant data.",
    retention: "Until the user clears site data.",
    deletion: "User theme toggle overwrites the value.",
  },
  {
    id: "privacy-consent",
    kind: "localStorage",
    locator: PRIVACY_CONSENT_STORAGE_KEY,
    owner: "frontend/components/layout/PrivacyConsentGate.tsx",
    sensitivity: "preference",
    scope: "browser profile (not incident)",
    schemaVersion: "1",
    migrate: "None. Consent is operator-policy, not incident data.",
    retention: "Until the user clears site data.",
    deletion: "User must clear site data to reset the gate.",
  },
  {
    id: "service-worker-caches",
    kind: "cache-api",
    locator: "CacheStorage names prefixed mallanet- plus kept v9 names",
    owner: "frontend/public/sw.js",
    sensitivity: "operational",
    scope: `epoch + org + incident (${COLOMBIA_INCIDENT_ID})`,
    schemaVersion: "e0",
    migrate:
      "Keep static-v9 / photos-v9 / api-v9 / html-v9 / rescue-data-v9. New names use prefix mallanet-. Delete only mallanet- names not in KEEP.",
    retention: "Current and previous static namespaces for rollback.",
    deletion:
      "Activate deletes owned prefix names that are not kept. Foreign caches stay.",
  },
];

export function renderBrowserStorageRegistryMarkdown(): string {
  const rows = BROWSER_STORAGE_REGISTRY.map(
    (e) =>
      `| ${e.id} | ${e.kind} | \`${e.locator}\` | ${e.owner} | ${e.sensitivity} | ${e.scope} | ${e.schemaVersion} | ${e.migrate} | ${e.retention} | ${e.deletion} |`,
  ).join("\n");
  return `# Browser storage registry (U20)

Generated from \`frontend/lib/browser-storage-registry.ts\`. Do not edit by hand.

Classification:

- **citizen-pii** — names, report drafts, photos on device
- **capability-token** — acopio edit tokens
- **auth** — session tokens. Never migrate between tenants
- **preference** — theme, consent, confirmed IDs, chat role, map view
- **operational** — rescue snapshots/packages, service-worker caches

| id | kind | locator | owner | sensitivity | scope | schemaVersion | migrate | retention | deletion |
|---|---|---|---|---|---|---|---|---|---|
${rows}
`;
}
