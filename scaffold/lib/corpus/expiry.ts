import type { Opportunity, OpportunityMap } from "../types";

/** Whether a deadline has already passed as of `now`. A missing/unparseable
 *  deadline (evergreen assistance, SBIR, procurement) is never expired. */
export function isExpiredDeadline(deadline: unknown, now: number = Date.now()): boolean {
  if (typeof deadline !== "string" || !deadline) return false;
  const t = Date.parse(deadline);
  if (Number.isNaN(t)) return false;
  return t < now;
}

/** Drop opportunities whose deadline has passed. Used both by the refresh
 *  pipeline (so an expired listing never lands in the local corpus) and by
 *  retrieval (so the gap between refreshes never surfaces a dead deadline). */
export function dropExpiredOpportunities<T extends { deadline?: unknown }>(
  opportunities: T[],
  now: number = Date.now(),
): T[] {
  return opportunities.filter((o) => !isExpiredDeadline(o.deadline, now));
}

/** Served from `data/precomputed.json`: filter out matches whose opportunity
 *  deadline has since passed, and keep the "closing in 90 days" count honest. */
export function dropExpiredMatches(map: OpportunityMap, now: number = Date.now()): OpportunityMap {
  const matches = map.matches.filter((m) => !isExpiredDeadline((m.opportunity as Opportunity).deadline, now));
  const closingIn90Days = matches.filter((m) => {
    const d = m.opportunity.deadline ? Date.parse(m.opportunity.deadline) : NaN;
    return !Number.isNaN(d) && d > now && d - now < 90 * 864e5;
  }).length;
  return { ...map, matches, summary: { ...map.summary, closingIn90Days } };
}
