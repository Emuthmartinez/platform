import { z } from "zod";

/**
 * Durable queue/BullMQ protocol (U20, KTD18).
 *
 * This clone has no `packages/contracts` yet (U1 arrives with U19). The
 * schemas live here so consumers can dual-decode without adding that
 * package. Producers still emit v1. Consumers accept v1 and v2.
 */
export const QUEUE_PROTOCOL_VERSION = 2 as const;

export const queueJobFamilySchema = z.enum(["needs", "imports", "matcher"]);
export type QueueJobFamily = z.infer<typeof queueJobFamilySchema>;

export const queueEnvelopeV2Schema = z.object({
  schemaVersion: z.literal(QUEUE_PROTOCOL_VERSION),
  organizationId: z.string().min(1),
  incidentId: z.string().min(1),
  idempotencyKey: z.string().min(1),
  producerBuildSha: z.string().min(1),
  createdAt: z.number().int(),
  family: queueJobFamilySchema,
  payload: z.unknown(),
});
export type QueueEnvelopeV2 = z.infer<typeof queueEnvelopeV2Schema>;

/** Legacy needs body. `need` is optional so today's empty `{}` messages parse. */
export const needsJobV1Schema = z
  .object({
    jobId: z.string().min(1).optional(),
    need: z.unknown().optional(),
    location: z.unknown().optional(),
  })
  .passthrough();
export type NeedsJobV1 = z.infer<typeof needsJobV1Schema>;

export const importJobV1Schema = z
  .object({
    importId: z.string().min(1),
    mode: z.enum(["process", "apply", "ocr"]),
    actorId: z.string().nullable().optional(),
    imageUrl: z.string().optional(),
    contentType: z.string().optional(),
    fileBase64: z.string().optional(),
    defaultHospitalId: z.string().optional(),
  })
  .passthrough();
export type ImportJobV1 = z.infer<typeof importJobV1Schema>;

export const matcherJobV1Schema = z.object({
  prn: z.string().min(1),
});
export type MatcherJobV1 = z.infer<typeof matcherJobV1Schema>;

/** Synthetic fixtures only. No citizen PII. */
export const QUEUE_PROTOCOL_FIXTURES = {
  needsV1: {
    jobId: "need-demo-1",
    need: { title: "Demo" },
  },
  needsV1Empty: {},
  needsV2: {
    schemaVersion: 2,
    organizationId: "org_mallanet",
    incidentId: "inc_terremoto_colombia_2026",
    idempotencyKey: "need-demo-v2",
    producerBuildSha: "deadbeef",
    createdAt: 1_786_320_000_000,
    family: "needs" as const,
    payload: {
      jobId: "need-demo-v2",
      need: { title: "Demo" },
    },
  },
  needsV2OtherTenant: {
    schemaVersion: 2,
    organizationId: "org_other",
    incidentId: "inc_other",
    idempotencyKey: "need-other-v2",
    producerBuildSha: "cafebabe",
    createdAt: 1_786_320_000_000,
    family: "needs" as const,
    payload: {
      jobId: "need-other-v2",
      need: { title: "Demo" },
    },
  },
  importsV1: {
    importId: "imp-demo-1",
    mode: "process" as const,
  },
  importsV2: {
    schemaVersion: 2,
    organizationId: "org_mallanet",
    incidentId: "inc_terremoto_colombia_2026",
    idempotencyKey: "imp-demo-v2",
    producerBuildSha: "deadbeef",
    createdAt: 1_786_320_000_000,
    family: "imports" as const,
    payload: {
      importId: "imp-demo-v2",
      mode: "apply" as const,
      actorId: "user-demo-1",
    },
  },
  matcherV1: {
    prn: "PRN-DEMO-0001",
  },
  matcherV2: {
    schemaVersion: 2,
    organizationId: "org_mallanet",
    incidentId: "inc_terremoto_colombia_2026",
    idempotencyKey: "prn-demo-v2",
    producerBuildSha: "deadbeef",
    createdAt: 1_786_320_000_000,
    family: "matcher" as const,
    payload: {
      prn: "PRN-DEMO-0002",
    },
  },
  unsupportedVersion: {
    schemaVersion: 99,
    organizationId: "org_mallanet",
    incidentId: "inc_terremoto_colombia_2026",
    idempotencyKey: "bad-version",
    producerBuildSha: "deadbeef",
    createdAt: 1_786_320_000_000,
    family: "needs" as const,
    payload: {},
  },
  wrongFamilyOnNeeds: {
    schemaVersion: 2,
    organizationId: "org_mallanet",
    incidentId: "inc_terremoto_colombia_2026",
    idempotencyKey: "wrong-family",
    producerBuildSha: "deadbeef",
    createdAt: 1_786_320_000_000,
    family: "imports" as const,
    payload: {
      importId: "imp-demo-wrong",
      mode: "process" as const,
    },
  },
} as const;
