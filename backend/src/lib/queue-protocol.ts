import {
  COLOMBIA_INCIDENT_ID,
  COLOMBIA_ORGANIZATION_ID,
} from "@/lib/colombia-tenant";
import type { NeedPublicationJob } from "@/modules/needs/infrastructure/needs-publication-queue";
import {
  importJobV1Schema,
  matcherJobV1Schema,
  needsJobV1Schema,
  queueEnvelopeV2Schema,
  type QueueEnvelopeV2,
  type QueueJobFamily,
} from "@/lib/queue-protocol-schema";

export interface ImportJobBody {
  importId: string;
  mode: "process" | "apply" | "ocr";
  actorId?: string | null;
  imageUrl?: string;
  contentType?: string;
  fileBase64?: string;
  defaultHospitalId?: string;
}

export interface MatcherJobBody {
  prn: string;
}

export type QueueDecodeReason = "malformed" | "unsupported_version" | "wrong_family";

export type QueueDecodeFailure = {
  ok: false;
  reason: QueueDecodeReason;
};

export type QueueDecodeSuccess<T> = {
  ok: true;
  legacy: boolean;
  schemaVersion: 1 | 2;
  organizationId: string;
  incidentId: string;
  idempotencyKey: string | null;
  producerBuildSha: string | null;
  createdAt: number | null;
  job: T;
};

export type QueueDecodeResult<T> = QueueDecodeSuccess<T> | QueueDecodeFailure;

const REDACT_KEY =
  /^(need|location|photo|photos|photoUrl|fileBase64|imageUrl|contact|contactPhone|document|documentNumber|name|fullName|email|phone|address|notes|diagnosis|author)$/i;

function asRecord(body: unknown): Record<string, unknown> | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  return body as Record<string, unknown>;
}

function schemaVersionOf(body: Record<string, unknown>): number | undefined {
  const value = body.schemaVersion;
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function logLegacyDecode(family: QueueJobFamily): void {
  console.log({
    t: "queue_decode",
    family,
    schema_version: 1,
    legacy: true,
  });
}

function unsupportedOrMalformed(version: number | undefined): QueueDecodeFailure {
  if (version !== undefined && version !== 1 && version !== 2) {
    return { ok: false, reason: "unsupported_version" };
  }
  return { ok: false, reason: "malformed" };
}

function decodeEnvelope(
  body: Record<string, unknown>,
  expectedFamily: QueueJobFamily,
): QueueDecodeFailure | { ok: true; envelope: QueueEnvelopeV2 } {
  const parsed = queueEnvelopeV2Schema.safeParse(body);
  if (!parsed.success) return { ok: false, reason: "malformed" };
  if (parsed.data.family !== expectedFamily) return { ok: false, reason: "wrong_family" };
  return { ok: true, envelope: parsed.data };
}

export function decodeNeedsJob(body: unknown): QueueDecodeResult<NeedPublicationJob> {
  const record = asRecord(body);
  if (!record) return { ok: false, reason: "malformed" };
  const version = schemaVersionOf(record);
  if (version === 2) {
    const decoded = decodeEnvelope(record, "needs");
    if (!decoded.ok) return decoded;
    const envelope = decoded.envelope;
    const payload = needsJobV1Schema.safeParse(envelope.payload);
    if (!payload.success) return { ok: false, reason: "malformed" };
    return {
      ok: true,
      legacy: false,
      schemaVersion: 2,
      organizationId: envelope.organizationId,
      incidentId: envelope.incidentId,
      idempotencyKey: envelope.idempotencyKey,
      producerBuildSha: envelope.producerBuildSha,
      createdAt: envelope.createdAt,
      job: {
        need: payload.data.need as NeedPublicationJob["need"],
        location: payload.data.location as NeedPublicationJob["location"],
        jobId: payload.data.jobId,
      },
    };
  }
  if (version !== undefined && version !== 1) return unsupportedOrMalformed(version);
  const parsed = needsJobV1Schema.safeParse(record);
  if (!parsed.success) return { ok: false, reason: "malformed" };
  logLegacyDecode("needs");
  return {
    ok: true,
    legacy: true,
    schemaVersion: 1,
    organizationId: COLOMBIA_ORGANIZATION_ID,
    incidentId: COLOMBIA_INCIDENT_ID,
    idempotencyKey: parsed.data.jobId ?? null,
    producerBuildSha: null,
    createdAt: null,
    job: {
      need: parsed.data.need as NeedPublicationJob["need"],
      location: parsed.data.location as NeedPublicationJob["location"],
      jobId: parsed.data.jobId,
    },
  };
}

export function decodeImportJob(body: unknown): QueueDecodeResult<ImportJobBody> {
  const record = asRecord(body);
  if (!record) return { ok: false, reason: "malformed" };
  const version = schemaVersionOf(record);
  if (version === 2) {
    const decoded = decodeEnvelope(record, "imports");
    if (!decoded.ok) return decoded;
    const envelope = decoded.envelope;
    const payload = importJobV1Schema.safeParse(envelope.payload);
    if (!payload.success) return { ok: false, reason: "malformed" };
    return {
      ok: true,
      legacy: false,
      schemaVersion: 2,
      organizationId: envelope.organizationId,
      incidentId: envelope.incidentId,
      idempotencyKey: envelope.idempotencyKey,
      producerBuildSha: envelope.producerBuildSha,
      createdAt: envelope.createdAt,
      job: {
        importId: payload.data.importId,
        mode: payload.data.mode,
        actorId: payload.data.actorId,
        imageUrl: payload.data.imageUrl,
        contentType: payload.data.contentType,
        fileBase64: payload.data.fileBase64,
        defaultHospitalId: payload.data.defaultHospitalId,
      },
    };
  }
  if (version !== undefined && version !== 1) return unsupportedOrMalformed(version);
  const parsed = importJobV1Schema.safeParse(record);
  if (!parsed.success) return { ok: false, reason: "malformed" };
  logLegacyDecode("imports");
  return {
    ok: true,
    legacy: true,
    schemaVersion: 1,
    organizationId: COLOMBIA_ORGANIZATION_ID,
    incidentId: COLOMBIA_INCIDENT_ID,
    idempotencyKey: parsed.data.importId,
    producerBuildSha: null,
    createdAt: null,
    job: {
      importId: parsed.data.importId,
      mode: parsed.data.mode,
      actorId: parsed.data.actorId,
      imageUrl: parsed.data.imageUrl,
      contentType: parsed.data.contentType,
      fileBase64: parsed.data.fileBase64,
      defaultHospitalId: parsed.data.defaultHospitalId,
    },
  };
}

export function decodeMatcherJob(body: unknown): QueueDecodeResult<MatcherJobBody> {
  const record = asRecord(body);
  if (!record) return { ok: false, reason: "malformed" };
  const version = schemaVersionOf(record);
  if (version === 2) {
    const decoded = decodeEnvelope(record, "matcher");
    if (!decoded.ok) return decoded;
    const envelope = decoded.envelope;
    const payload = matcherJobV1Schema.safeParse(envelope.payload);
    if (!payload.success) return { ok: false, reason: "malformed" };
    return {
      ok: true,
      legacy: false,
      schemaVersion: 2,
      organizationId: envelope.organizationId,
      incidentId: envelope.incidentId,
      idempotencyKey: envelope.idempotencyKey,
      producerBuildSha: envelope.producerBuildSha,
      createdAt: envelope.createdAt,
      job: { prn: payload.data.prn },
    };
  }
  if (version !== undefined && version !== 1) return unsupportedOrMalformed(version);
  const parsed = matcherJobV1Schema.safeParse(record);
  if (!parsed.success) return { ok: false, reason: "malformed" };
  logLegacyDecode("matcher");
  return {
    ok: true,
    legacy: true,
    schemaVersion: 1,
    organizationId: COLOMBIA_ORGANIZATION_ID,
    incidentId: COLOMBIA_INCIDENT_ID,
    idempotencyKey: parsed.data.prn,
    producerBuildSha: null,
    createdAt: null,
    job: { prn: parsed.data.prn },
  };
}

export function requireNeedsJob(body: unknown): NeedPublicationJob {
  const decoded = decodeNeedsJob(body);
  if (!decoded.ok) throw new Error(`needs job ${decoded.reason}`);
  return decoded.job;
}

export function requireImportJob(body: unknown): ImportJobBody {
  const decoded = decodeImportJob(body);
  if (!decoded.ok) throw new Error(`import job ${decoded.reason}`);
  return decoded.job;
}

export function requireMatcherJob(body: unknown): MatcherJobBody {
  const decoded = decodeMatcherJob(body);
  if (!decoded.ok) throw new Error(`matcher job ${decoded.reason}`);
  return decoded.job;
}

function redactKey(key: string): boolean {
  return REDACT_KEY.test(key) || /photo|contact|document|base64|file/i.test(key);
}

/** Redact citizen fields before a durable receipt. Keep operational ids. */
export function redactQueuePayload(body: unknown): unknown {
  if (Array.isArray(body)) return body.map(redactQueuePayload);
  if (typeof body !== "object" || body === null) return body;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    if (redactKey(key)) {
      out[key] = "[redacted]";
      continue;
    }
    out[key] = redactQueuePayload(value);
  }
  return out;
}

export function extractPreservedErrorSummary(body: unknown): string | undefined {
  const record = asRecord(body);
  if (!record) return undefined;
  const direct = record.errorSummary ?? record.error_summary;
  if (typeof direct === "string" && direct.length > 0) return direct.slice(0, 500);
  for (const nestedKey of ["payload", "body"] as const) {
    const nested = asRecord(record[nestedKey]);
    if (!nested) continue;
    const nestedVal = nested.errorSummary ?? nested.error_summary;
    if (typeof nestedVal === "string" && nestedVal.length > 0) {
      return nestedVal.slice(0, 500);
    }
  }
  return undefined;
}
