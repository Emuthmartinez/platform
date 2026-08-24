export type QueueKind =
  | "needs"
  | "needs-dlq"
  | "imports"
  | "imports-dlq"
  | "matcher"
  | "matcher-dlq"
  | "unknown";

export type QueueEnvironment = "production" | "staging" | "compose";

export interface RegisteredQueue {
  readonly name: string;
  readonly kind: Exclude<QueueKind, "unknown">;
  readonly environment: QueueEnvironment;
}

/**
 * Exact Cloudflare Queue and BullMQ names for this deployment.
 * Classification is exact-match only. Do not add substring fallbacks.
 */
export const REGISTERED_QUEUES: readonly RegisteredQueue[] = [
  { name: "mallanet-platform-needs", kind: "needs", environment: "production" },
  { name: "mallanet-platform-needs-staging", kind: "needs", environment: "staging" },
  { name: "mallanet-platform-needs-dlq", kind: "needs-dlq", environment: "production" },
  {
    name: "mallanet-platform-needs-dlq-staging",
    kind: "needs-dlq",
    environment: "staging",
  },
  { name: "mallanet-platform-imports", kind: "imports", environment: "production" },
  {
    name: "mallanet-platform-imports-staging",
    kind: "imports",
    environment: "staging",
  },
  {
    name: "mallanet-platform-imports-dlq",
    kind: "imports-dlq",
    environment: "production",
  },
  {
    name: "mallanet-platform-imports-dlq-staging",
    kind: "imports-dlq",
    environment: "staging",
  },
  { name: "mallanet-platform-matcher", kind: "matcher", environment: "production" },
  {
    name: "mallanet-platform-matcher-staging",
    kind: "matcher",
    environment: "staging",
  },
  {
    name: "mallanet-platform-matcher-dlq",
    kind: "matcher-dlq",
    environment: "production",
  },
  {
    name: "mallanet-platform-matcher-dlq-staging",
    kind: "matcher-dlq",
    environment: "staging",
  },
  { name: "needs-publication", kind: "needs", environment: "compose" },
  { name: "patient-imports", kind: "imports", environment: "compose" },
];

const KIND_BY_NAME = new Map<string, Exclude<QueueKind, "unknown">>(
  REGISTERED_QUEUES.map((entry) => [entry.name, entry.kind]),
);

export function lookupQueueKind(name: string): QueueKind {
  return KIND_BY_NAME.get(name) ?? "unknown";
}

export function cloudflareQueueNames(environment: "production" | "staging"): string[] {
  return REGISTERED_QUEUES.filter((entry) => entry.environment === environment).map(
    (entry) => entry.name,
  );
}
