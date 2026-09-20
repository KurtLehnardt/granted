import type { AlertProfileLike } from "./types";

/**
 * Deterministic, dependency-free string hash (FNV-1a, 32-bit) so this module
 * stays framework-agnostic (no crypto/Node/browser API dependency) and
 * produces the exact same digest for the exact same input on server and
 * client alike.
 */
function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

/**
 * A stable identity for "this user's search," derived from the handful of
 * profile fields that meaningfully change what the corpus matches against.
 * Two runs with the same description/industry/technology/location/funding
 * stage hash to the same key, so a saved alert snapshot from a prior run is
 * recognized as comparable; a materially different profile hashes to a
 * different key, so diffOpportunities correctly treats it as "no prior
 * snapshot" instead of producing nonsensical cross-profile alerts.
 *
 * Pure/deterministic: no Date.now(), no randomness, no storage access.
 */
export function computeProfileKey(profile: AlertProfileLike): string {
  const parts = [
    profile?.description ?? "",
    profile?.industry ?? "",
    profile?.technology ?? "",
    profile?.location ?? "",
    profile?.fundingStage ?? "",
  ].map((s) => s.trim().toLowerCase());
  return fnv1a(parts.join(""));
}
