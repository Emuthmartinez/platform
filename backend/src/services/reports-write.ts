import { eq, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { invalidate } from "@/lib/cache";
import { persistPhotoDataUrl } from "@/lib/r2";
import { isAllowedImageDataUrl } from "@/lib/image";
import {
  MAX_REPORT_PHOTO_CHARS,
  REPORT_TYPE_KEYS,
  type CreateReportInput,
  type ReportDTO,
  type UpdateReportInput,
} from "@/services/report-types";
import { getReportById } from "@/services/reports-read";
import { incidentOwnership } from "@/tenant/ownership";
import type { TenantScope } from "@/tenant/scope";

const { reports } = schema;

function createReport(input: CreateReportInput): {
  report: ReportDTO;
  photo: string | null;
} {
  const type = REPORT_TYPE_KEYS.includes(input.type) ? input.type : "critical";
  const id = crypto.randomUUID();
  const photo =
    typeof input.photo === "string" &&
    input.photo &&
    isAllowedImageDataUrl(input.photo) &&
    input.photo.length <= MAX_REPORT_PHOTO_CHARS
      ? input.photo
      : null;
  return {
    photo,
    report: {
      id,
      type,
      lat: Number(input.lat),
      lng: Number(input.lng),
      place: input.place.trim().slice(0, 200),
      affected: Math.max(0, Math.trunc(Number(input.affected) || 0)),
      needs: (input.needs ?? "").trim().slice(0, 1000),
      photoUrl: photo ? `/api/reports/${id}/photo` : null,
      confirmations: 0,
      createdAt: Date.now(),
    },
  };
}

export async function addReport(
  input: CreateReportInput,
  scope: TenantScope,
): Promise<ReportDTO> {
  const { report, photo } = createReport(input);
  let stored = photo;
  let migratedAt: number | null = null;
  if (photo) {
    ({ stored, migratedAt } = await persistPhotoDataUrl(
      photo,
      "reports",
      report.id,
    ));
  }
  const db = await getDb();
  await db.insert(reports).values({
    id: report.id,
    type: report.type,
    lat: report.lat,
    lng: report.lng,
    place: report.place,
    affected: report.affected,
    needs: report.needs,
    photo: stored,
    photoMigratedAt: migratedAt,
    volunteerId: input.volunteerId ?? null,
    createdAt: report.createdAt,
    ...incidentOwnership(scope),
  });
  invalidate();
  return report;
}

export async function confirmReport(
  id: string,
  ipKey: string,
  scope: TenantScope,
): Promise<
  | { status: "confirmed"; confirmations: number }
  | { status: "duplicate" }
  | { status: "not-found" }
> {
  const db = await getDb();
  const ownership = incidentOwnership(scope);
  const res = (await db.execute(sql`
    WITH target AS (
      SELECT id FROM reports WHERE id = ${id}
    ), ins AS (
      INSERT INTO report_confirmations (report_id, ip_hash, created_at, organization_id, incident_id)
      SELECT id, ${ipKey}, ${Date.now()}, ${ownership.organizationId}, ${ownership.incidentId} FROM target
      ON CONFLICT DO NOTHING
      RETURNING report_id
    ), updated AS (
    UPDATE reports r SET confirmations = confirmations + 1
    FROM ins WHERE r.id = ins.report_id
    RETURNING r.confirmations
    )
    SELECT EXISTS(SELECT 1 FROM target) AS exists,
           (SELECT confirmations FROM updated) AS confirmations
  `)) as unknown;
  const rows = (Array.isArray(res) ? res : (res as { rows: unknown[] }).rows) as
    | { exists: boolean; confirmations: number | null }[]
    | undefined;
  const row = rows?.[0];
  if (!row?.exists) return { status: "not-found" };
  if (row.confirmations === null) return { status: "duplicate" };
  invalidate();
  return { status: "confirmed", confirmations: Number(row.confirmations) };
}

export async function updateReport(
  id: string,
  input: UpdateReportInput,
  _scope: TenantScope,
): Promise<ReportDTO | null> {
  const db = await getDb();
  const patch: Record<string, unknown> = {};
  if (input.type !== undefined && REPORT_TYPE_KEYS.includes(input.type)) {
    patch.type = input.type;
  }
  if (input.lat !== undefined) patch.lat = Number(input.lat);
  if (input.lng !== undefined) patch.lng = Number(input.lng);
  if (input.place !== undefined) patch.place = input.place.trim().slice(0, 200);
  if (input.affected !== undefined) {
    patch.affected = Math.max(0, Math.trunc(Number(input.affected) || 0));
  }
  if (input.needs !== undefined) patch.needs = input.needs.trim().slice(0, 1000);
  if (Object.keys(patch).length === 0) return getReportById(id);
  await db.update(reports).set(patch).where(eq(reports.id, id));
  invalidate();
  return getReportById(id);
}

export async function removeReport(
  id: string,
  _scope: TenantScope,
): Promise<boolean> {
  const db = await getDb();
  const res = (await db.execute(
    sql`DELETE FROM ${reports} WHERE ${reports.id} = ${id} RETURNING id`,
  )) as unknown;
  const rows = (Array.isArray(res) ? res : (res as { rows: unknown[] }).rows) as unknown[];
  if (rows.length > 0) invalidate();
  return rows.length > 0;
}
