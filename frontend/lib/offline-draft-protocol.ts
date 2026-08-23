import { REPORT_TYPE_KEYS, type ReportType } from "./types";
import {
  COLOMBIA_INCIDENT_ID,
  COLOMBIA_ORGANIZATION_ID,
} from "@/lib/tenant";

/**
 * Offline report drafts (U20). These are drafts, not guaranteed submissions.
 * v1 IndexedDB rows had `{ localId, payload, createdAt }` with no tenant or
 * status. The consumer migrates them to schemaVersion 2 with
 * `verification_required`.
 */
export const OFFLINE_DRAFT_SCHEMA_VERSION = 2;
export const MAX_OFFLINE_DRAFTS = 20;
export const MAX_OFFLINE_DRAFT_BYTES = 1_500_000;
export const MAX_OFFLINE_DRAFTS_TOTAL_BYTES = 6_000_000;
export const OFFLINE_DRAFT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export type OfflineDraftStatus =
  | "ready"
  | "verification_required"
  | "expired"
  | "incompatible";

export interface QueuedPayload {
  type: ReportType;
  lat: number;
  lng: number;
  place: string;
  affected: number;
  needs: string;
  photo: string | null;
  volunteerCode?: string;
}

export interface OfflineDraft {
  schemaVersion: typeof OFFLINE_DRAFT_SCHEMA_VERSION;
  localId: string;
  organizationId: string;
  incidentId: string;
  idempotencyKey: string;
  producerBuildSha: string;
  createdAt: number;
  status: OfflineDraftStatus;
  payload: QueuedPayload;
}

export class OfflineDraftQuotaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OfflineDraftQuotaError";
  }
}

export function draftByteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function isReportType(value: unknown): value is ReportType {
  return typeof value === "string" && REPORT_TYPE_KEYS.includes(value as ReportType);
}

function stripTurnstile(payload: QueuedPayload): QueuedPayload {
  const { type, lat, lng, place, affected, needs, photo, volunteerCode } =
    payload;
  return volunteerCode
    ? { type, lat, lng, place, affected, needs, photo, volunteerCode }
    : { type, lat, lng, place, affected, needs, photo };
}

function parsePayload(raw: unknown): QueuedPayload | null {
  if (!raw || typeof raw !== "object") return null;
  const p = raw as Record<string, unknown>;
  if (!isReportType(p.type)) return null;
  if (typeof p.lat !== "number" || typeof p.lng !== "number") return null;
  if (typeof p.place !== "string" || typeof p.needs !== "string") return null;
  if (typeof p.affected !== "number") return null;
  if (p.photo !== null && typeof p.photo !== "string") return null;
  const volunteerCode =
    typeof p.volunteerCode === "string" ? p.volunteerCode : undefined;
  return stripTurnstile({
    type: p.type,
    lat: p.lat,
    lng: p.lng,
    place: p.place,
    affected: p.affected,
    needs: p.needs,
    photo: p.photo,
    volunteerCode,
  });
}

export function isV1OfflineDraft(raw: unknown): boolean {
  if (!raw || typeof raw !== "object") return false;
  const row = raw as Record<string, unknown>;
  if ("schemaVersion" in row) return false;
  return (
    typeof row.localId === "string" &&
    typeof row.createdAt === "number" &&
    parsePayload(row.payload) !== null
  );
}

function applyExpiry(
  status: OfflineDraftStatus,
  createdAt: number,
  now: number,
): OfflineDraftStatus {
  if (status === "incompatible") return status;
  if (now - createdAt > OFFLINE_DRAFT_RETENTION_MS) return "expired";
  return status;
}

export function migrateV1OfflineDraft(
  raw: unknown,
  now = Date.now(),
  producerBuildSha = "dev",
): OfflineDraft | null {
  if (!isV1OfflineDraft(raw)) return null;
  const row = raw as {
    localId: string;
    createdAt: number;
    payload: unknown;
  };
  const payload = parsePayload(row.payload);
  if (!payload) return null;
  const status = applyExpiry("verification_required", row.createdAt, now);
  return {
    schemaVersion: OFFLINE_DRAFT_SCHEMA_VERSION,
    localId: row.localId,
    organizationId: COLOMBIA_ORGANIZATION_ID,
    incidentId: COLOMBIA_INCIDENT_ID,
    idempotencyKey: row.localId,
    producerBuildSha,
    createdAt: row.createdAt,
    status,
    payload,
  };
}

export function decodeOfflineDraft(
  raw: unknown,
  opts: {
    now?: number;
    organizationId?: string;
    incidentId?: string;
  } = {},
): { draft: OfflineDraft; persist: boolean } | { error: "malformed" } {
  const now = opts.now ?? Date.now();
  const organizationId = opts.organizationId ?? COLOMBIA_ORGANIZATION_ID;
  const incidentId = opts.incidentId ?? COLOMBIA_INCIDENT_ID;

  const v1 = migrateV1OfflineDraft(raw, now);
  if (v1) {
    if (v1.organizationId !== organizationId || v1.incidentId !== incidentId) {
      return { draft: { ...v1, status: "incompatible" }, persist: true };
    }
    return { draft: v1, persist: true };
  }

  if (!raw || typeof raw !== "object") return { error: "malformed" };
  const row = raw as Record<string, unknown>;
  if (row.schemaVersion !== OFFLINE_DRAFT_SCHEMA_VERSION) {
    return { error: "malformed" };
  }
  if (typeof row.localId !== "string" || typeof row.createdAt !== "number") {
    return { error: "malformed" };
  }
  const payload = parsePayload(row.payload);
  if (!payload) return { error: "malformed" };
  const org =
    typeof row.organizationId === "string" ? row.organizationId : "";
  const incident = typeof row.incidentId === "string" ? row.incidentId : "";
  const idempotencyKey =
    typeof row.idempotencyKey === "string" ? row.idempotencyKey : row.localId;
  const producerBuildSha =
    typeof row.producerBuildSha === "string" ? row.producerBuildSha : "dev";
  let status: OfflineDraftStatus = "verification_required";
  if (
    row.status === "ready" ||
    row.status === "verification_required" ||
    row.status === "expired" ||
    row.status === "incompatible"
  ) {
    status = row.status;
  }
  if (org !== organizationId || incident !== incidentId) {
    status = "incompatible";
  } else {
    status = applyExpiry(status, row.createdAt, now);
  }
  return {
    draft: {
      schemaVersion: OFFLINE_DRAFT_SCHEMA_VERSION,
      localId: row.localId,
      organizationId: org || organizationId,
      incidentId: incident || incidentId,
      idempotencyKey,
      producerBuildSha,
      createdAt: row.createdAt,
      status,
      payload,
    },
    persist: status === "expired" || row.status !== status,
  };
}

export function evaluateDraftQuota(
  existing: readonly OfflineDraft[],
  incoming: OfflineDraft,
): void {
  const others = existing.filter((d) => d.localId !== incoming.localId);
  if (others.length + 1 > MAX_OFFLINE_DRAFTS) {
    throw new OfflineDraftQuotaError(
      `Hay ${MAX_OFFLINE_DRAFTS} borradores en este dispositivo. Exporta o elimina uno para guardar otro.`,
    );
  }
  const incomingBytes = draftByteLength(incoming);
  if (incomingBytes > MAX_OFFLINE_DRAFT_BYTES) {
    throw new OfflineDraftQuotaError(
      "Este borrador (incluida la foto) supera el límite de 1.5 MB.",
    );
  }
  const total =
    others.reduce((sum, d) => sum + draftByteLength(d), 0) + incomingBytes;
  if (total > MAX_OFFLINE_DRAFTS_TOTAL_BYTES) {
    throw new OfflineDraftQuotaError(
      "Los borradores de este dispositivo superan el límite de 6 MB. Exporta o elimina uno.",
    );
  }
}

export function mayAutoDeleteDraft(input: {
  confirmedDurableSubmission: boolean;
}): boolean {
  return input.confirmedDurableSubmission;
}

export function exportOfflineDraftJson(draft: OfflineDraft): string {
  return JSON.stringify(
    {
      schemaVersion: draft.schemaVersion,
      localId: draft.localId,
      organizationId: draft.organizationId,
      incidentId: draft.incidentId,
      idempotencyKey: draft.idempotencyKey,
      createdAt: draft.createdAt,
      status: draft.status,
      payload: draft.payload,
    },
    null,
    2,
  );
}

export function newDraftFromPayload(
  payload: QueuedPayload,
  opts: {
    localId: string;
    createdAt: number;
    status: OfflineDraftStatus;
    producerBuildSha: string;
    organizationId?: string;
    incidentId?: string;
  },
): OfflineDraft {
  return {
    schemaVersion: OFFLINE_DRAFT_SCHEMA_VERSION,
    localId: opts.localId,
    organizationId: opts.organizationId ?? COLOMBIA_ORGANIZATION_ID,
    incidentId: opts.incidentId ?? COLOMBIA_INCIDENT_ID,
    idempotencyKey: opts.localId,
    producerBuildSha: opts.producerBuildSha,
    createdAt: opts.createdAt,
    status: opts.status,
    payload: stripTurnstile(payload),
  };
}
