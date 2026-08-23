import { desc, eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { persistPhotoDataUrl } from "@/lib/r2";
import { getVolunteerByCode } from "@/services/volunteers";
import { incidentOwnership } from "@/tenant/ownership";
import type { TenantScope } from "@/tenant/scope";

const { volunteerCheckins, volunteers } = schema;

const LIST_LIMIT = 500;

export interface VolunteerCheckinDTO {
  id: string;
  volunteerName: string;
  volunteerCode: string;
  place: string;
  note: string;
  hasPhoto: boolean;
  photo: string | null;
  createdAt: number;
}

export async function createVolunteerCheckin(input: {
  code: string;
  place: string;
  note: string;
  photo?: string | null;
  availability?: string;
  talent?: string;
  area?: string;
}, scope: TenantScope): Promise<{ id: string } | null> {
  const volunteer = await getVolunteerByCode(input.code);
  if (!volunteer) return null;
  const id = crypto.randomUUID();
  let stored: string | null = null;
  if (input.photo) {
    ({ stored } = await persistPhotoDataUrl(input.photo, "volunteer_checkins", id));
  }
  const db = await getDb();
  const availability = input.availability?.trim();
  const talent = input.talent?.trim();
  const area = input.area?.trim();
  const patch: {
    availability?: string;
    fieldRole?: string;
    zone?: string;
    updatedAt: number;
  } = { updatedAt: Date.now() };
  let hasStatus = false;
  if (availability) {
    patch.availability = availability;
    hasStatus = true;
  }
  if (talent) {
    patch.fieldRole = talent;
    hasStatus = true;
  }
  if (area) {
    patch.zone = area;
    hasStatus = true;
  }
  if (hasStatus) {
    await db.update(volunteers).set(patch).where(eq(volunteers.id, volunteer.id));
  }
  await db.insert(volunteerCheckins).values({
    id,
    volunteerId: volunteer.id,
    place: input.place,
    note: input.note,
    photo: stored,
    createdAt: Date.now(),
    ...incidentOwnership(scope),
  });
  return { id };
}

export async function listVolunteerCheckins(): Promise<VolunteerCheckinDTO[]> {
  const db = await getDb();
  const rows = await db
    .select({
      id: volunteerCheckins.id,
      place: volunteerCheckins.place,
      note: volunteerCheckins.note,
      photo: volunteerCheckins.photo,
      createdAt: volunteerCheckins.createdAt,
      volunteerName: volunteers.name,
      volunteerCode: volunteers.code,
    })
    .from(volunteerCheckins)
    .innerJoin(volunteers, eq(volunteerCheckins.volunteerId, volunteers.id))
    .orderBy(desc(volunteerCheckins.createdAt))
    .limit(LIST_LIMIT);
  return rows.map((r) => ({
    id: r.id,
    volunteerName: r.volunteerName,
    volunteerCode: r.volunteerCode,
    place: r.place,
    note: r.note,
    hasPhoto: Boolean(r.photo),
    photo: r.photo && !r.photo.startsWith("data:") ? r.photo : null,
    createdAt: Number(r.createdAt),
  }));
}
