export const PLATFORM_CAPABILITIES = [
  "platform:portfolio:read",
  "platform:provisioning:read",
  "platform:provisioning:plan",
  "platform:provisioning:approve",
  "platform:provisioning:apply",
  "platform:operators:manage",
  "platform:audit:read",
] as const;

export type PlatformCapability = (typeof PLATFORM_CAPABILITIES)[number];

const known = new Set<string>(PLATFORM_CAPABILITIES);

export function isPlatformCapability(value: string): value is PlatformCapability {
  return known.has(value);
}
