import { describe, expect, it } from "vitest";
import { assertApplyAuthority, assertApprovalAuthority } from "@/platform/provisioning-authority";

describe("U23 durable separation of duties", () => {
  it("rejects self approval", () => {
    expect(() => assertApprovalAuthority({ createdBy: "op-a", status: "planned" }, "op-a"))
      .toThrow(/cannot approve/i);
  });

  it("rejects apply by the approving operator and any unapproved run", () => {
    expect(() =>
      assertApplyAuthority({ approvedBy: "op-b", status: "approved" }, "op-b"),
    ).toThrow(/cannot apply/i);
    expect(() => assertApplyAuthority({ approvedBy: null, status: "planned" }, "op-c"))
      .toThrow(/approved before apply/i);
  });

  it("permits an operator other than the approver to resume a waiting-external run", () => {
    expect(() =>
      assertApplyAuthority({ approvedBy: "op-b", status: "waiting_external" }, "op-c"),
    ).not.toThrow();
  });
});
