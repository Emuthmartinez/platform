import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it } from "vitest";
import {
  clearClientQueriesOnScopeChange,
  resetQueryScopeForTests,
} from "@/lib/query-scope";

describe("query scope", () => {
  afterEach(() => {
    resetQueryScopeForTests();
  });

  it("does not clear on the first mount of the current tenant", () => {
    const client = new QueryClient();
    client.setQueryData(["demo"], 1);
    clearClientQueriesOnScopeChange(client);
    expect(client.getQueryData(["demo"])).toBe(1);
  });
});
