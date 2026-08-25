import { badRequest, conflict, forbidden } from "@/lib/errors";

export function assertApprovalAuthority(
  run: { createdBy: string; status: string },
  operatorId: string,
): void {
  if (run.createdBy === operatorId) {
    throw forbidden("The operator who created a plan cannot approve it.");
  }
  if (run.status !== "planned") throw conflict("Only a planned run can be approved.");
}

export function assertApplyAuthority(
  run: { approvedBy: string | null; status: string },
  operatorId: string,
): void {
  if (!run.approvedBy) throw badRequest("The run must be approved before apply.");
  if (run.approvedBy === operatorId) {
    throw forbidden("The approving operator cannot apply the run.");
  }
  if (!["approved", "applying", "waiting_external"].includes(run.status)) {
    throw conflict("This run cannot be applied from its current state.");
  }
}
