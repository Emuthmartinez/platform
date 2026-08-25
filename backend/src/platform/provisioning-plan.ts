import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalJson } from "@/lib/canonical-json";
import { badRequest } from "@/lib/errors";

export interface ProvisioningRequest {
  organization: { key: string; name: string };
  incident: { key: string; name: string };
  deployment: { key: string; hostname: string };
}

export interface ProvisioningStep {
  key: string;
  execution: "automatic" | "external";
  description: string;
}

export interface ProvisioningPlan {
  schemaVersion: 1;
  targetLifecycle: "preview";
  desiredState: ProvisioningRequest;
  steps: ProvisioningStep[];
}

export const provisioningPlanSchema = z.object({
  schemaVersion: z.literal(1),
  targetLifecycle: z.literal("preview"),
  desiredState: z.object({
    organization: z.object({ key: z.string(), name: z.string() }),
    incident: z.object({ key: z.string(), name: z.string() }),
    deployment: z.object({ key: z.string(), hostname: z.string() }),
  }),
  steps: z
    .array(
      z.object({
        key: z.enum([
          "organization.ensure",
          "incident.ensure",
          "deployment.preview.ensure",
          "external.cloudflare.worker",
          "external.cloudflare.dns",
          "external.runtime.secrets",
        ]),
        execution: z.enum(["automatic", "external"]),
        description: z.string().min(1),
      }),
    )
    .length(6),
});

const KEY = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const HOSTNAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

function requireKey(value: string, label: string): string {
  if (!KEY.test(value)) throw badRequest(`${label} must be a lowercase stable key`);
  return value;
}

function isPreviewHostname(hostname: string): boolean {
  return hostname.split(/[.-]/).some((part) => part === "preview" || part === "staging");
}

export function buildProvisioningPlan(input: ProvisioningRequest): ProvisioningPlan {
  const hostname = input.deployment.hostname.trim();
  if (hostname !== hostname.toLowerCase() || !HOSTNAME.test(hostname)) {
    throw badRequest("deployment hostname must be a canonical hostname");
  }
  if (!isPreviewHostname(hostname)) {
    throw badRequest("deployment.hostname must identify a preview or staging route");
  }
  const deploymentKey = requireKey(input.deployment.key, "deployment.key");
  if (!/(?:preview|staging)/.test(deploymentKey)) {
    throw badRequest("deployment.key must identify a preview or staging deployment");
  }
  const desiredState: ProvisioningRequest = {
    organization: {
      key: requireKey(input.organization.key, "organization.key"),
      name: input.organization.name.trim(),
    },
    incident: {
      key: requireKey(input.incident.key, "incident.key"),
      name: input.incident.name.trim(),
    },
    deployment: { key: deploymentKey, hostname },
  };
  if (!desiredState.organization.name || !desiredState.incident.name) {
    throw badRequest("organization and incident names are required");
  }
  return {
    schemaVersion: 1,
    targetLifecycle: "preview",
    desiredState,
    steps: [
      { key: "organization.ensure", execution: "automatic", description: "Ensure organization catalog record" },
      { key: "incident.ensure", execution: "automatic", description: "Ensure draft incident catalog record" },
      { key: "deployment.preview.ensure", execution: "automatic", description: "Record an unrouted preview deployment specification" },
      { key: "external.cloudflare.worker", execution: "external", description: "Provision isolated preview Workers" },
      { key: "external.cloudflare.dns", execution: "external", description: "Verify and attach preview DNS" },
      { key: "external.runtime.secrets", execution: "external", description: "Install environment-scoped runtime secrets" },
    ],
  };
}

export function provisioningPlanDigest(plan: ProvisioningPlan): string {
  return createHash("sha256").update(canonicalJson(plan)).digest("hex");
}
