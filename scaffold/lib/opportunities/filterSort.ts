import { normalizeStateName } from "../location";

/**
 * Match-results filter/sort (pure helpers) — location, match %, award amount,
 * recency.
 *
 * Mirrors `lib/opportunities/group.ts`'s shape exactly: dependency-light,
 * hermetically-testable derivations over the already-computed `matches` a map
 * carries. `components/OpportunityFilters.tsx` renders on top of these;
 * nothing here recomputes scoring, retrieval, or eligibility.
 */

/** Minimal match shape the filter/sort needs — a structural subset of
 *  `Match` (mirrors `GroupableMatch` in group.ts). */
export type FilterableMatch = {
  score?: number;
  opportunity?: {
    id?: string;
    geography?: string;
    fundingLow?: number;
    fundingHigh?: number;
    award_range?: { floor?: number; ceiling?: number };
    retrieved_at?: string;
  };
};

export type SortKey = "match" | "award" | "recency";

/** Same precedence as `components/ApplicationChecklist.tsx`'s
 *  `buildFundingRange` (the Canon `award_range` wins over the legacy
 *  `fundingLow`/`fundingHigh` when both exist) — kept numeric here instead
 *  of formatted, and returns `undefined` (never 0) when nothing is known, so
 *  an unknown amount can never outrank or masquerade as a real $0. */
export function awardAmountForSort(m: FilterableMatch): number | undefined {
  const o = m.opportunity;
  if (!o) return undefined;
  const high = o.award_range?.ceiling ?? o.fundingHigh;
  const low = o.award_range?.floor ?? o.fundingLow;
  const amount = typeof high === "number" && high > 0 ? high : typeof low === "number" && low > 0 ? low : undefined;
  return amount;
}

/** The distinct, normalized states actually present among `matches`' own
 *  `geography` (never offer a filter for a state that isn't there — mirrors
 *  `availableKinds`'s same rule in group.ts). Sorted alphabetically for a
 *  stable, predictable control order. */
export function availableLocations(matches: FilterableMatch[] | null | undefined): string[] {
  const present = new Set<string>();
  for (const m of Array.isArray(matches) ? matches : []) {
    const resolved = normalizeStateName(m?.opportunity?.geography);
    if (resolved) present.add(resolved);
  }
  return Array.from(present).sort();
}

/**
 * Keep matches whose opportunity's `geography` matches `state`, PLUS every
 * match with no `geography` at all. A `null`/`undefined` `state` means "no
 * filter" and returns every match unchanged (order preserved).
 *
 * Opportunities with no `geography` are federal/nationwide-scoped (today:
 * every grants.gov/SBIR/SAM record) — absence means "unknown/unscoped," never
 * "excluded." A location filter must never hide a nationwide opportunity just
 * because it doesn't carry a state, matching this codebase's "never silently
 * drop a real match" rule (§2, the same reasoning WeakerMatches exists for).
 *
 * A PRESENT but unrecognizable `geography` (e.g. a future source writing
 * something `normalizeStateName` can't resolve) gets the SAME treatment as
 * an absent one, not the opposite — it's just as "unscoped" from this
 * filter's point of view. Comparing through the normalizer on both sides
 * (rather than short-circuiting on truthiness) means a garbled value can
 * never flip from visible-by-default to silently-hidden the instant a user
 * picks any specific state.
 */
export function filterByLocation<M extends FilterableMatch>(
  matches: M[] | null | undefined,
  state: string | null | undefined,
): M[] {
  const list = Array.isArray(matches) ? matches : [];
  if (!state) return [...list];
  return list.filter((m) => {
    const resolved = normalizeStateName(m?.opportunity?.geography);
    return !resolved || resolved === normalizeStateName(state);
  });
}

/** Stable score-desc, id-asc comparator — the pipeline's own default order
 *  (matches `lib/match.ts`'s sort, and `group.ts`'s `byScoreThenId`). */
function byScoreThenId(a: FilterableMatch, b: FilterableMatch): number {
  const ds = (b.score ?? 0) - (a.score ?? 0);
  if (ds !== 0) return ds;
  const ai = a.opportunity?.id ?? "";
  const bi = b.opportunity?.id ?? "";
  return ai < bi ? -1 : ai > bi ? 1 : 0;
}

/**
 * Reorders `matches` by `key` — never changes membership, only order (same
 * contract as `filterByLocation`/`filterByKinds`). `"match"` is today's
 * implicit default (score desc). `"award"` sorts by `awardAmountForSort`
 * descending, with no-data matches pinned LAST regardless of direction (an
 * unknown amount is never shown as more or less promising than a real one).
 * `"recency"` sorts by `retrieved_at` descending (newest first), with
 * missing-timestamp matches last — this is Granted's own first-seen
 * timestamp (`refresh-corpus.mjs`'s `retrieved_at` stamp), i.e. "added to
 * Granted," never "posted by the agency" (that date isn't reliably available
 * from any source).
 */
export function sortMatches<M extends FilterableMatch>(matches: M[] | null | undefined, key: SortKey): M[] {
  const list = Array.isArray(matches) ? [...matches] : [];
  if (key === "award") {
    return list.sort((a, b) => {
      const av = awardAmountForSort(a);
      const bv = awardAmountForSort(b);
      if (av === undefined && bv === undefined) return byScoreThenId(a, b);
      if (av === undefined) return 1;
      if (bv === undefined) return -1;
      return bv - av || byScoreThenId(a, b);
    });
  }
  if (key === "recency") {
    return list.sort((a, b) => {
      const at = a.opportunity?.retrieved_at ? Date.parse(a.opportunity.retrieved_at) : NaN;
      const bt = b.opportunity?.retrieved_at ? Date.parse(b.opportunity.retrieved_at) : NaN;
      const aValid = !Number.isNaN(at);
      const bValid = !Number.isNaN(bt);
      if (!aValid && !bValid) return byScoreThenId(a, b);
      if (!aValid) return 1;
      if (!bValid) return -1;
      return bt - at || byScoreThenId(a, b);
    });
  }
  return list.sort(byScoreThenId);
}
