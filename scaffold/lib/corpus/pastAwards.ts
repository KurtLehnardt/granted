import type { Opportunity, OpportunityMap } from "../types";

/**
 * Owner decision: a past award must never surface as a match. Users don't
 * want to see what someone else already got — that context belongs only in
 * the award-history ("previously awarded companies") and competitor-analysis
 * features, which read `data/awards.json` / their own live retrieval
 * (`lib/competitors/retrieve.ts`), never the matchable corpus.
 *
 * Two record shapes in the corpus are past awards, not open opportunities:
 *   - SBIR/STTR: source "sbir", id "sbir-award-*" (scripts/1-fetch-sbir-corpus.mjs
 *     / scripts/lib/normalizeNewSources.mjs's `normalizeSbirAward`). A genuine
 *     open SBIR/STTR solicitation is also source "sbir" but id "sbir-*"
 *     (no "-award-"), from `normalizeSbirSolicitation` — so the id prefix, not
 *     the source, is what distinguishes them.
 *   - USAspending: source "usaspending", status "closed" (every record
 *     `normalizeProcurementRecord` produces is a closed/past contract award).
 */
export function isPastAward(o: Pick<Opportunity, "source" | "id"> & { status?: string }): boolean {
  if (o.source === "sbir" && o.id.startsWith("sbir-award-")) return true;
  if (o.source === "usaspending" && o.status === "closed") return true;
  return false;
}

export function dropPastAwards<T extends Pick<Opportunity, "source" | "id"> & { status?: string }>(
  opportunities: T[],
): T[] {
  return opportunities.filter((o) => !isPastAward(o));
}

/** Mirrors `dropExpiredMatches` (lib/corpus/expiry.ts): filters a cached/precomputed
 *  map's matches and recomputes only the counts that filter derives. */
export function dropPastAwardMatches(map: OpportunityMap, now: number = Date.now()): OpportunityMap {
  const matches = map.matches.filter((m) => !isPastAward(m.opportunity as Opportunity));
  const closingIn90Days = matches.filter((m) => {
    const d = m.opportunity.deadline ? Date.parse(m.opportunity.deadline) : NaN;
    return !Number.isNaN(d) && d > now && d - now < 90 * 864e5;
  }).length;
  return { ...map, matches, summary: { ...map.summary, closingIn90Days } };
}
