/**
 * F1 — pure, hermetic helpers behind the Opportunity Map's honesty rules:
 *
 *   1. Forecasted-vs-current: a program that hasn't opened yet must never be
 *      labeled/implied as open now (N3).
 *   2. Evergreen-safe math: a rolling/continuous/standing (or otherwise
 *      deadline-less/funding-less) listing must never show a fabricated
 *      "$0+" figure or a "closing soon" flag it doesn't actually have.
 *
 * Framework-agnostic (no React, no DOM) so both rules are exhaustively unit
 * tested without rendering anything — mirrors the `lib/similar/aggregate.ts`
 * / `components/AgencyMap.tsx` "*Like" minimal-shape pattern: these functions
 * consume a structural subset of `Opportunity` / `Match` rather than
 * importing the zod contracts, so the module stays dependency-light and both
 * `components/OpportunityMap.tsx` and `components/OpportunityCard.tsx` can
 * share a single source of truth instead of drifting copies.
 */

/** Minimal opportunity shape the availability/evergreen rules need — a
 *  structural subset of `Opportunity` (lib/contracts/opportunity.ts). */
export type OpportunityAvailabilityLike = {
  status?: string;
  forecasted?: boolean;
  deadline?: string;
};

const EVERGREEN_STATUSES = new Set(["rolling", "continuous", "standing"]);

/**
 * Is this program forecasted (anticipated, not yet open)? The legacy v1
 * `forecasted` boolean is the primary/most-populated signal (most corpus
 * records only ever carry this), and it wins when explicitly set — an
 * explicit `forecasted:false` must never be overridden by a stray/incorrect
 * `status`. Falls back to the §3.4 Canon `status:"forecasted"` when the
 * boolean itself is absent.
 */
export function isForecasted(o: OpportunityAvailabilityLike): boolean {
  if (typeof o.forecasted === "boolean") return o.forecasted;
  return o.status === "forecasted";
}

/**
 * Is this an evergreen (rolling / continuous / standing) program — one that
 * never had a "closing soon" clock in the first place? Based ONLY on the
 * explicit Canon `status` field: we deliberately do NOT infer "evergreen"
 * from a merely-missing deadline (that's just missing data, not a positive
 * "this is a rolling program" claim) — this codebase's honesty rule is to
 * never assert more than the data supports (see lib/canon's evergreen
 * normalization, which sets `status` explicitly for true evergreen records).
 * Forecasted always wins: a not-yet-open program is never "evergreen" even
 * if it's slated to become a rolling program once it opens.
 */
export function isEvergreen(o: OpportunityAvailabilityLike): boolean {
  if (isForecasted(o)) return false;
  return typeof o.status === "string" && EVERGREEN_STATUSES.has(o.status);
}

export type OpportunityAvailabilityKind = "forecasted" | "rolling" | "open" | "closed";

export type OpportunityAvailability = {
  kind: OpportunityAvailabilityKind;
  label: string;
};

/**
 * The single honest availability label for a card/section (N3). Never
 * fabricates a status the data doesn't support: an opportunity with no
 * `status` and no `deadline` (and not `forecasted`) simply gets no label —
 * that's a genuine "we don't know," not "open."
 */
export function opportunityAvailability(o: OpportunityAvailabilityLike): OpportunityAvailability | null {
  if (isForecasted(o)) return { kind: "forecasted", label: "Forecasted — not yet open" };
  if (o.status === "closed") return { kind: "closed", label: "Closed" };
  if (isEvergreen(o)) return { kind: "rolling", label: "Rolling — no fixed deadline" };
  if (o.status === "open") return { kind: "open", label: "Open now" };
  // No Canon `status` yet (common on v1/cached records): a real deadline is
  // the honest signal that this is a currently-open call, not a guess.
  if (o.deadline) return { kind: "open", label: "Open now" };
  return null;
}

/**
 * Evergreen-safe "closing within `windowDays`" check (default 90, matching
 * the header stat band). Defense-in-depth, same posture as `fundingCell`'s
 * "$0" guard below: an evergreen/closed record can never read as
 * "closing soon" even if a stray/legacy deadline-shaped value is present on
 * the record — the explicit status always wins.
 */
export function isClosingSoon(
  o: OpportunityAvailabilityLike,
  opts?: { now?: number; windowDays?: number },
): boolean {
  if (isEvergreen(o) || o.status === "closed") return false;
  if (!o.deadline) return false;
  const t = Date.parse(o.deadline);
  if (Number.isNaN(t)) return false;
  const now = opts?.now ?? Date.now();
  const windowMs = (opts?.windowDays ?? 90) * 864e5;
  return t >= now && t <= now + windowMs;
}

/**
 * Has this opportunity's stated deadline already passed (data-freshness)? The
 * committed corpus is a point-in-time snapshot, so a self-hoster who clones
 * months later inherits opportunities whose deadlines are now in the past —
 * currently rendered as if current. This is the deterministic, evergreen-safe
 * "expired" read that badges them honestly.
 *
 * A program is EXPIRED iff its `deadline` parses to a date STRICTLY BEFORE
 * `now`. It is NEVER expired when:
 *   - it is evergreen (rolling / continuous / standing) or forecasted (not yet
 *     open) — those never had a real closing clock in the first place (reuses
 *     `isEvergreen` / `isForecasted`, the same guards behind `isClosingSoon`);
 *   - its `deadline` is absent or unparseable (Invalid Date) — that's missing
 *     data, not a passed deadline, so we never assert it expired.
 *
 * Mirror-image of `isClosingSoon` (which requires `t >= now`): the two are
 * mutually exclusive, so an expired program can never also read "closing soon".
 */
export function isDeadlinePassed(
  o: OpportunityAvailabilityLike,
  opts?: { now?: number },
): boolean {
  if (isEvergreen(o) || isForecasted(o)) return false;
  if (!o.deadline) return false;
  const t = Date.parse(o.deadline);
  if (Number.isNaN(t)) return false;
  const now = opts?.now ?? Date.now();
  return t < now;
}

/** How many of the shown matches have a passed deadline — drives the one-line
 *  "N of these have passed deadlines" summary caveat. Evergreen-safe via
 *  `isDeadlinePassed` above (a rolling/forecasted program is never counted). */
export function expiredCount(shown: FundingMatchLike[], opts?: { now?: number }): number {
  return shown.filter((m) => m.opportunity && isDeadlinePassed(m.opportunity, opts)).length;
}

// ---------------------------------------------------------------------------
// Header stat-band money/funding formatting (moved from OpportunityMap.tsx so
// it's covered by the same hermetic test suite as the rules above).
// ---------------------------------------------------------------------------

export const money = (n: number): string =>
  n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M+` : `$${Math.round(n / 1e3)}K+`;

/** Minimal match shape `fundingCell`/`closingSoonCount` need — a structural
 *  subset of `Match` (lib/types.ts). */
export type FundingMatchLike = {
  tier?: string;
  opportunity?: OpportunityAvailabilityLike & {
    fundingLow?: number;
    fundingHigh?: number;
  };
  history?: {
    medianAward?: number;
    totalAwarded?: number;
  };
};

/**
 * Recompute the header funding figure from what we actually render. The raw
 * summary.fundingIdentified is 0 on every case because strong matches lack
 * opportunity.fundingHigh — so we fall back to fundingLow, then to the median
 * historical award, and finally to total awarded to similar companies.
 * Never returns a "$0+" cell: each tier only renders once its sum is > 0,
 * and the function returns `null` (render nothing) rather than a fabricated
 * zero when every tier is empty — this is the funding-honesty guard the
 * evergreen "closing soon" checks above mirror.
 */
export function fundingCell(shown: FundingMatchLike[]): { n: string; label: string } | null {
  const strong = shown.filter((m) => m.tier === "likely" || m.tier === "verify");

  // Prefer the programs' own stated funding ranges — that's real "potential funding".
  const stated = strong.reduce((acc, m) => acc + (m.opportunity?.fundingHigh ?? m.opportunity?.fundingLow ?? 0), 0);
  if (stated > 0) return { n: money(stated), label: "potential funding identified" };

  // Otherwise fall back to what similar companies actually received — and label
  // it honestly as such, not as this founder's potential funding.
  const median = strong.reduce((acc, m) => acc + (m.history?.medianAward ?? 0), 0);
  if (median > 0) return { n: money(median), label: "median award to similar companies" };

  const awarded = shown.reduce((acc, m) => acc + (m.history?.totalAwarded ?? 0), 0);
  if (awarded > 0) return { n: money(awarded), label: "awarded to similar companies" };

  return null; // Never show "$0+".
}

/** Header stat-band "closing within `windowDays`" count — evergreen-safe via
 *  `isClosingSoon` above (an evergreen program is never counted). */
export function closingSoonCount(shown: FundingMatchLike[], opts?: { now?: number; windowDays?: number }): number {
  return shown.filter((m) => m.opportunity && isClosingSoon(m.opportunity, opts)).length;
}
