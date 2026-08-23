import { describe, expect, it } from "vitest";
import { ACOPIO_EDIT_TOKENS_KEY } from "@/lib/browser-storage-registry";
import { COLOMBIA_INCIDENT_ID } from "@/lib/tenant";

describe("acopio edit token namespace", () => {
  it("scopes the storage key by incident and protocol version", () => {
    expect(ACOPIO_EDIT_TOKENS_KEY).toBe(
      `acopio.editTokens:v2:${COLOMBIA_INCIDENT_ID}`,
    );
  });
});
