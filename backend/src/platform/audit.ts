import { createHash, randomUUID } from "node:crypto";
import { getDb, schema } from "@/db";

export async function writePlatformAudit(input: {
  actorOperatorId: string;
  action: string;
  targetType?: string;
  targetId?: string;
  metadata?: Record<string, unknown>;
  dedupeKey?: string;
}): Promise<void> {
  const id = input.dedupeKey
    ? createHash("sha256").update(`platform-audit:${input.dedupeKey}`).digest("hex")
    : randomUUID();
  await getDb()
    .insert(schema.platformAuditLog)
    .values({
      id,
      actorOperatorId: input.actorOperatorId,
      action: input.action,
      targetType: input.targetType ?? null,
      targetId: input.targetId ?? null,
      metadata: input.metadata ?? null,
      createdAt: Date.now(),
    })
    .onConflictDoNothing({ target: schema.platformAuditLog.id });
}
