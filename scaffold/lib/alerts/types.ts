/**
 * lib/alerts/types.ts — D5 shared types for the client-only "Opportunity
 * Alerts" diff (see diff.ts) and its localStorage snapshot (see store.ts).
 *
 * Framework-agnostic on purpose (no React, no Next.js imports) — same
 * posture as lib/localStore.ts / lib/similar/aggregate.ts, so the diff logic
 * stays hermetically unit-testable without a DOM.
 */

import type { Tier } from "@/lib/types";

export const VALID_TIERS: readonly Tier[] = ["likely", "verify", "adjacent", "none"];

/** What we remembered about one matched opportunity the last time this
 *  profile's map was saved. */
export interface AlertSnapshotEntry {
  tier: Tier;
  /**
   * Whether this opportunity's deadline fell within the next 90 days as of
   * `savedAt`. Lets the diff detect a NEW closing-soon transition (deadline
   * just entered the window since last save) rather than re-alerting every
   * visit on an opportunity that was already flagged closing soon.
   */
  closingSoon: boolean;
}

/** The full snapshot persisted to localStorage after each visit. */
export interface AlertSnapshot {
  /**
   * Stable identity for the user's profile/search this snapshot belongs
   * to (see profileKey.ts's computeProfileKey). Comparing against a snapshot
   * saved under a different profile would produce meaningless "new
   * opportunity" noise, so diffOpportunities only compares entries when the
   * keys match.
   */
  profileKey: string;
  /** ISO timestamp this snapshot was written. */
  savedAt: string;
  /**
   * Keyed by opportunity id. Only opportunities with tier !== "none" (the
   * real fits the user actually sees as cards) are tracked.
   */
  opportunities: Record<string, AlertSnapshotEntry>;
}

export type AlertKind = "new" | "tier_upgrade" | "closing_soon";

export interface AlertItem {
  kind: AlertKind;
  opportunityId: string;
  title: string;
  agency?: string;
  tier: Tier;
  /** Present only for kind === "tier_upgrade". */
  previousTier?: Tier;
}

/**
 * Minimal match shape the pure diff needs — a subset of `Match`, mirroring
 * the dependency-light `*Like` pattern used by lib/similar/aggregate.ts and
 * components/AgencyMap.tsx so this module has no contract-schema dependency
 * and stays trivially testable with plain object literals.
 */
export type AlertMatchLike = {
  tier?: string;
  opportunity?: {
    id?: string;
    title?: string;
    program?: string;
    agency?: string;
    deadline?: string;
  };
};

/** Minimal profile shape computeProfileKey needs. */
export type AlertProfileLike =
  | {
      description?: string;
      industry?: string;
      technology?: string;
      location?: string;
      fundingStage?: string;
    }
  | null
  | undefined;
