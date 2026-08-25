import { describe, expect, it } from "vitest";
import {
  buildProvisioningPlan,
  provisioningPlanDigest,
} from "@/platform/provisioning-plan";

const request = {
  organization: { key: "demo-relief", name: "Demo Relief" },
  incident: { key: "demo-quake-2026", name: "Demo Quake 2026" },
  deployment: { key: "demo-quake-2026-staging", hostname: "staging.demo-quake.example.org" },
};

describe("U23 deterministic preview provisioning", () => {
  it("builds the same ordered plan and digest for the same desired state", () => {
    const first = buildProvisioningPlan(request);
    const second = buildProvisioningPlan({
      deployment: { ...request.deployment },
      incident: { ...request.incident },
      organization: { ...request.organization },
    });

    expect(second).toEqual(first);
    expect(provisioningPlanDigest(second)).toBe(provisioningPlanDigest(first));
    expect(first.steps.map((step) => step.key)).toEqual([
      "organization.ensure",
      "incident.ensure",
      "deployment.preview.ensure",
      "external.cloudflare.worker",
      "external.cloudflare.dns",
      "external.runtime.secrets",
    ]);
  });

  it("never plans public activation", () => {
    const plan = buildProvisioningPlan(request);

    expect(plan.targetLifecycle).toBe("preview");
    expect(plan.steps.some((step) => step.key.includes("activate"))).toBe(false);
    expect(plan.steps.filter((step) => step.execution === "external")).toHaveLength(3);
  });

  it("rejects non-canonical hostnames and reserved production-like targets", () => {
    expect(() =>
      buildProvisioningPlan({
        ...request,
        deployment: { ...request.deployment, hostname: "HTTPS://Example.org/" },
      }),
    ).toThrow(/canonical hostname/i);
    expect(() =>
      buildProvisioningPlan({
        ...request,
        deployment: { ...request.deployment, key: "demo-production" },
      }),
    ).toThrow(/preview or staging/i);
    expect(() =>
      buildProvisioningPlan({
        ...request,
        deployment: { ...request.deployment, hostname: "terremotocolombia.co" },
      }),
    ).toThrow(/preview or staging route/i);
  });
});
