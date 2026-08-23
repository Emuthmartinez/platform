import { describe, expect, it } from "vitest";
import {
  BROWSER_STORAGE_REGISTRY,
  ACOPIO_EDIT_TOKENS_KEY,
  ACOPIO_EDIT_TOKENS_LEGACY_KEY,
  ADMIN_SESSION_TOKEN_KEY,
  PRIVACY_CONSENT_STORAGE_KEY as registryPrivacy,
} from "@/lib/browser-storage-registry";
import { PRIVACY_CONSENT_STORAGE_KEY } from "@/lib/privacy-policy";
import { COLOMBIA_INCIDENT_ID } from "@/lib/tenant";

describe("browser storage registry", () => {
  it("inventories offline drafts, rescue, acopio tokens, and auth isolation", () => {
    const ids = BROWSER_STORAGE_REGISTRY.map((e) => e.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        "offline-report-drafts",
        "rescue-map-snapshot",
        "rescue-map-packages",
        "acopio-edit-tokens",
        "confirmed-report-ids",
        "chat-display-name",
        "legacy-admin-session-token",
        "service-worker-caches",
      ]),
    );
  });

  it("namespaces acopio tokens by incident and keeps the legacy key for migrate", () => {
    expect(ACOPIO_EDIT_TOKENS_KEY).toContain(COLOMBIA_INCIDENT_ID);
    expect(ACOPIO_EDIT_TOKENS_LEGACY_KEY).toBe("acopio.editTokens");
    expect(ACOPIO_EDIT_TOKENS_KEY).not.toBe(ACOPIO_EDIT_TOKENS_LEGACY_KEY);
  });

  it("does not migrate the admin session token between tenants", () => {
    const auth = BROWSER_STORAGE_REGISTRY.find(
      (e) => e.id === "legacy-admin-session-token",
    );
    expect(auth?.locator).toBe(ADMIN_SESSION_TOKEN_KEY);
    expect(auth?.migrate.toLowerCase()).toContain("do not migrate");
  });

  it("keeps the privacy consent key in sync with the gate", () => {
    expect(registryPrivacy).toBe(PRIVACY_CONSENT_STORAGE_KEY);
  });
});
