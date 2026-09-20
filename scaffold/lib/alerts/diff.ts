import type { Tier } from "@/lib/types";
import type {
  AlertItem,
  AlertMatchLike,
  AlertSnapshot,
  AlertSnapshotEntry,
} from "./types";

/**
 * lib/alerts/diff.ts — D5 "Opportunity Alerts" pure diff logic.
 *
 * Given the snapshot saved from a user's last visit (or none) and the
 * matches on the CURRENT OpportunityMap, computes what's new or changed:
 * new opportunities, tier upgrades, and newly closing-soon deadlines.
 *
 * Deliberately storage-free: no localStorage/fetch/Date.now() read directly
 * (see the `now` parameter) so this is hermetically unit-testable with plain
 * object literals and no DOM. Storage read/write lives in store.ts;
 * OpportunityAlerts.tsx wires the two together.
 */

const TIER_RANK: Record<Tier, number> = { none: 0, adjacent: 1, verify: 2, likely: 3 };

/** True when `next` is a strictly higher tier than `prev` (adjacent -> verify -> likely). */
function isTierUpgrade(prev: Tier, next: Tier): boolean {
  return TIER_RANK[next] > TIER_RANK[prev];
}

const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;

/** Mirrors components/OpportunityMap.tsx's withinNinetyDays, parameterized
 *  by `now` so this stays deterministic/testable instead of reading
 *  Date.now() itself. */
function withinNinetyDays(deadline: string | undefined, now: number): boolean {
  if (!deadline) return false;
  const t = Date.parse(deadline);
  if (Number.isNaN(t)) return false;
  return t >= now && t <= now + NINETY_DAYS_MS;
}

export interface DiffOpportunitiesResult {
  alerts: AlertItem[];
  /** The snapshot to persist for next time — pass straight to saveAlertSnapshot. */
  nextSnapshot: AlertSnapshot;
}

/**
 * Pure, hermetic diff: compares the previously-saved snapshot (if any, and
 * only if it belongs to the SAME profile — see computeProfileKey in
 * profileKey.ts) against the current map's matches, and returns both the
 * alerts to surface and the snapshot to persist for the next visit.
 *
 * Detects, per real-fit opportunity (tier !== "none"):
 *   - "new"          — wasn't in the previous snapshot at all
 *   - "tier_upgrade"  — was present, tier improved (adjacent -> verify -> likely)
 *   - "closing_soon" — was present at the same tier, but its deadline just
 *                       entered the 90-day window since the last save
 *
 * Priority per opportunity is new > tier_upgrade > closing_soon: each id
 * produces at most one alert so the list never double-counts the same
 * opportunity. An unchanged opportunity (same tier, same closing-soon state,
 * already seen) produces no alert at all.
 *
 * No storage access here — callers own reading the previous snapshot and
 * persisting nextSnapshot; this function only computes.
 */
export function diffOpportunities(
  previous: AlertSnapshot | null | undefined,
  profileKey: string,
  matches: AlertMatchLike[] | null | undefined,
  now: number = Date.now(),
): DiffOpportunitiesResult {
  const safeMatches = Array.isArray(matches) ? matches : [];
  const prevOpportunities: Record<string, AlertSnapshotEntry> =
    previous && previous.profileKey === profileKey ? previous.opportunities : {};

  const alerts: AlertItem[] = [];
  const nextOpportunities: Record<string, AlertSnapshotEntry> = {};

  for (const m of safeMatches) {
    if (!m) continue;
    const id = m.opportunity?.id;
    const tier = m.tier as Tier | undefined;
    if (!id || !tier || tier === "none") continue;

    const closingSoon = withinNinetyDays(m.opportunity?.deadline, now);
    nextOpportunities[id] = { tier, closingSoon };

    const title = m.opportunity?.title ?? m.opportunity?.program ?? id;
    const agency = m.opportunity?.agency;
    const prevEntry = prevOpportunities[id];

    if (!prevEntry) {
      alerts.push({ kind: "new", opportunityId: id, title, agency, tier });
    } else if (isTierUpgrade(prevEntry.tier, tier)) {
      alerts.push({
        kind: "tier_upgrade",
        opportunityId: id,
        title,
        agency,
        tier,
        previousTier: prevEntry.tier,
      });
    } else if (closingSoon && !prevEntry.closingSoon) {
      alerts.push({ kind: "closing_soon", opportunityId: id, title, agency, tier });
    }
  }

  return {
    alerts,
    nextSnapshot: {
      profileKey,
      savedAt: new Date(now).toISOString(),
      opportunities: nextOpportunities,
    },
  };
}
