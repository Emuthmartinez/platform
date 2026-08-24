import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function read(rel: string): string {
  return readFileSync(new URL(`../../../${rel}`, import.meta.url), "utf8");
}

describe("isolated platform Worker names", () => {
  it("wrangler names are mallanet-platform-* and never terremotocolombia-*", () => {
    const files = [
      "backend/wrangler.jsonc",
      "admin/wrangler.jsonc",
      "frontend/wrangler.jsonc",
    ];
    for (const rel of files) {
      const text = read(rel);
      const names = [...text.matchAll(/"name":\s*"([^"]+)"/g)].map((m) => m[1]);
      const workerNames = names.filter((n) => n !== "EDGE_RATE_LIMITER");
      expect(workerNames.length, rel).toBeGreaterThan(0);
      for (const name of workerNames) {
        expect(name, rel).toMatch(/^mallanet-platform-/);
        expect(name, rel).not.toMatch(/terremotocolombia/);
      }
    }
  });

  it("staging workers.dev is on and URLs are not Colombia hosts", () => {
    const backend = read("backend/wrangler.jsonc");
    const admin = read("admin/wrangler.jsonc");
    expect(backend).toMatch(/"name": "mallanet-platform-api-staging"[\s\S]*?"workers_dev": true/);
    expect(admin).toMatch(/"name": "mallanet-platform-admin-staging"[\s\S]*?"workers_dev": true/);
    expect(backend).not.toMatch(/terremotocolombia\.co/);
    expect(admin).not.toMatch(/terremotocolombia\.co/);
    expect(backend).toMatch(/ENABLE_STRIPE_DONATIONS": "false"/);
  });

  it("GitHub deploy workflows and probes do not target Colombia hosts", () => {
    const files = [
      ".github/workflows/deploy-staging.yml",
      ".github/workflows/deploy-backend.yml",
      ".github/workflows/deploy-admin.yml",
      ".github/workflows/deploy-frontend.yml",
      "scripts/verify-jobs.sh",
      "scripts/verify-turnstile.sh",
    ];
    for (const rel of files) {
      const text = read(rel);
      expect(text, rel).not.toMatch(/terremotocolombia/);
      expect(text, rel).not.toMatch(/494895363b65d50699864543d005238a/);
    }
  });
});
