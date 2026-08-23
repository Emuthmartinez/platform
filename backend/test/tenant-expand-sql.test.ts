import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(HERE, "../../infra/db/migrations");

describe("U7 tenant expand SQL", () => {
  it("declares incident-ownership FKs as NOT VALID (KTD6)", () => {
    const files = readdirSync(MIGRATIONS_DIR)
      .filter((f) => /^\d{4}_.+\.sql$/.test(f) && f >= "0015_")
      .sort();
    expect(files.length).toBeGreaterThan(0);

    const missing: string[] = [];
    for (const file of files) {
      const text = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
      const adds = text.matchAll(
        /ADD CONSTRAINT "([^"]+_incident_ownership_fk)" FOREIGN KEY[\s\S]*?(?=;|$)/g,
      );
      for (const match of adds) {
        if (!/NOT VALID/.test(match[0])) {
          missing.push(`${file}: ${match[1]}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });
});
