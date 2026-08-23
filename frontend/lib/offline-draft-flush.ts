import type { EmergencyReport } from "@/lib/types";
import type { OfflineDraft, QueuedPayload } from "@/lib/offline-draft-protocol";
import { mayAutoDeleteDraft } from "@/lib/offline-draft-protocol";

export type FlushPostOutcome =
  | { status: "ok"; report?: EmergencyReport }
  | { status: "queue" }
  | { status: "drop"; error: string };

/**
 * Auto-flush only `ready` drafts. Never delete on drop (403, validation).
 * verification_required drafts wait for an explicit user submit.
 */
export async function flushReadyDrafts(opts: {
  drafts: readonly OfflineDraft[];
  post: (payload: QueuedPayload) => Promise<FlushPostOutcome>;
  remove: (localId: string) => Promise<void>;
  onAccepted?: (report: EmergencyReport | undefined) => void;
}): Promise<"complete" | "stopped"> {
  for (const draft of opts.drafts) {
    if (draft.status !== "ready") continue;
    const outcome = await opts.post(draft.payload);
    if (outcome.status === "ok") {
      if (mayAutoDeleteDraft({ confirmedDurableSubmission: true })) {
        await opts.remove(draft.localId);
      }
      opts.onAccepted?.(outcome.report);
      continue;
    }
    if (outcome.status === "drop") {
      continue;
    }
    return "stopped";
  }
  return "complete";
}
