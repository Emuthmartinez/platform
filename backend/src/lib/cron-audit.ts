import { getDb, schema } from "@/db";
import { CRON_EXPRESSIONS } from "@/services/cron-jobs";

/** Durable alert for a Cron expression this Worker does not handle. */
export async function persistUnhandledCron(cron: string): Promise<void> {
  await getDb()
    .insert(schema.auditLog)
    .values({
      actorUserId: null,
      action: "cron.unhandled",
      targetType: "cron",
      targetId: cron,
      metadata: {
        outcome: "unhandled",
        expected: [...CRON_EXPRESSIONS],
      },
      ipHash: null,
      createdAt: Date.now(),
    });
}
