/**
 * Schema sync — volunteers* must mirror live Neon columns (SCH-1).
 * Pure unit: asserts Drizzle table exports + column names (no DB I/O).
 */
import { describe, expect, it } from "vitest";
import { getTableColumns } from "drizzle-orm";
import {
  volunteers,
  volunteerTasks,
  volunteerAssignments,
} from "../../infra/db/schema";

function columnNames(table: Parameters<typeof getTableColumns>[0]): string[] {
  return Object.values(getTableColumns(table)).map((c) => c.name).sort();
}

describe("volunteer schema (Neon-aligned)", () => {
  it("volunteers exposes introspected columns", () => {
    expect(columnNames(volunteers)).toEqual(
      [
        "id",
        "name",
        "contact",
        "offer",
        "zone",
        "status",
        "notes",
        "ip_hash",
        "created_at",
        "updated_at",
        "availability",
        "offer_types",
        "digital_skills",
        "crisis_experience",
        "field_city",
        "rescue_training",
        "field_role",
        "own_vehicle",
        "source",
        "code",
        "organization_id",
        "incident_id",
      ].sort(),
    );
  });

  it("volunteer_tasks exposes introspected columns", () => {
    expect(columnNames(volunteerTasks)).toEqual(
      [
        "id",
        "title",
        "description",
        "kind",
        "city",
        "origin_name",
        "origin_lat",
        "origin_lng",
        "dest_name",
        "dest_lat",
        "dest_lng",
        "transport_note",
        "status",
        "created_at",
        "updated_at",
        "organization_id",
        "incident_id",
      ].sort(),
    );
  });

  it("volunteer_assignments exposes introspected columns", () => {
    expect(columnNames(volunteerAssignments)).toEqual(
      [
        "id",
        "task_id",
        "volunteer_id",
        "token",
        "status",
        "created_at",
        "updated_at",
        "organization_id",
        "incident_id",
      ].sort(),
    );
  });
});
