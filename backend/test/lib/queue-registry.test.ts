import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  REGISTERED_QUEUES,
  cloudflareQueueNames,
  lookupQueueKind,
} from "@/lib/queue-registry";

describe("queue registry", () => {
  it("classifies every registered name and rejects substring hits", () => {
    for (const entry of REGISTERED_QUEUES) {
      expect(lookupQueueKind(entry.name)).toBe(entry.kind);
    }
    expect(lookupQueueKind("otra-cola")).toBe("unknown");
    expect(lookupQueueKind("foo-needs-bar")).toBe("unknown");
    expect(lookupQueueKind("terremotocolombia-needs-extra")).toBe("unknown");
  });

  it("matches wrangler.jsonc producer and consumer names exactly", () => {
    const path = fileURLToPath(new URL("../../wrangler.jsonc", import.meta.url));
    const raw = readFileSync(path, "utf8");
    const config = JSON.parse(raw.replace(/^\s*\/\/.*$/gm, "")) as {
      queues?: {
        producers?: { queue: string }[];
        consumers?: { queue: string; dead_letter_queue?: string }[];
      };
      env?: {
        staging?: {
          queues?: {
            producers?: { queue: string }[];
            consumers?: { queue: string; dead_letter_queue?: string }[];
          };
        };
      };
    };

    const names = (block?: {
      producers?: { queue: string }[];
      consumers?: { queue: string; dead_letter_queue?: string }[];
    }): string[] => {
      const out = new Set<string>();
      for (const producer of block?.producers ?? []) out.add(producer.queue);
      for (const consumer of block?.consumers ?? []) {
        out.add(consumer.queue);
        if (consumer.dead_letter_queue) out.add(consumer.dead_letter_queue);
      }
      return [...out].sort();
    };

    expect(names(config.queues)).toEqual(cloudflareQueueNames("production").sort());
    expect(names(config.env?.staging?.queues)).toEqual(
      cloudflareQueueNames("staging").sort(),
    );
  });
});
