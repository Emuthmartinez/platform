import { describe, expect, it } from "vitest";
import {
  classificationProblems,
  drizzleTableNames,
  loadClassification,
} from "@/lib/table-classification";

describe("U7 table classification (KTD10)", () => {
  it("matches every Drizzle table exactly once with a valid scope", () => {
    const file = loadClassification();
    const names = drizzleTableNames();
    expect(classificationProblems(file, names)).toEqual([]);
    expect(names.length).toBeGreaterThan(50);
  });

  it("fails closed when a Drizzle table is missing from the artifact", () => {
    const file = loadClassification();
    const names = [...drizzleTableNames(), "temporary_unclassified"];
    expect(
      classificationProblems(file, names).some((p) =>
        p.includes("temporary_unclassified"),
      ),
    ).toBe(true);
  });
});
