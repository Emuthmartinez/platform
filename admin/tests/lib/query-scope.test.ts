import { describe, expect, it } from "vitest";
import { scopedQueryKey } from "@/src/lib/query-scope";
import {
  COLOMBIA_INCIDENT_ID,
  COLOMBIA_ORGANIZATION_ID,
  TENANT_CACHE_EPOCH,
} from "@/src/lib/tenant";

describe("scopedQueryKey", () => {
  it("prefixes incident-scoped admin keys", () => {
    expect(scopedQueryKey("admin", "roles")).toEqual([
      COLOMBIA_ORGANIZATION_ID,
      COLOMBIA_INCIDENT_ID,
      TENANT_CACHE_EPOCH,
      "admin",
      "roles",
    ]);
  });
});
