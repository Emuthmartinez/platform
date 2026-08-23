/**
 * Non-sensitive build identifier. Cloudflare and Docker builds must set
 * APP_BUILD_SHA to the full git SHA. Local/dev falls back to "dev".
 *
 * This clone does not yet carry the rest of Colombia U0. Offline drafts and
 * the SW config generator need this helper for producerBuildSha.
 */
export const APP_BUILD_SHA_HEADER = "x-app-build-sha";

export function getAppBuildSha(): string {
  const value = process.env.APP_BUILD_SHA;
  if (typeof value !== "string") return "dev";
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : "dev";
}
