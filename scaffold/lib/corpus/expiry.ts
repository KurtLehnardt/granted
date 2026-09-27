import type { Opportunity, OpportunityMap } from "../types";

const ISO_DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const US_DATE_ONLY = /^\d{1,2}\/\d{1,2}\/\d{4}$/;

function startOfLocalDay(t: number): number {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Whether a deadline has already passed as of `now`. A missing/unparseable
 *  deadline (evergreen assistance, SBIR, procurement) is never expired.
 *
 *  A date-only deadline (grants.gov closeDate 'MM/DD/YYYY', SBIR close_date
 *  'YYYY-MM-DD') names a whole calendar day, not an instant — `Date.parse`
 *  reads the US form as local midnight and the ISO form as UTC midnight, so
 *  comparing either directly against `now` drops a grant on the morning (or,
 *  in US timezones, the evening before) of its own closing day. Compare the
 *  deadline's local calendar date against today's instead: expired only once
 *  today is past it. */
export function isExpiredDeadline(deadline: unknown, now: number = Date.now()): boolean {
  if (typeof deadline !== "string" || !deadline) return false;
  const trimmed = deadline.trim();
  const todayStart = startOfLocalDay(now);
  if (ISO_DATE_ONLY.test(trimmed)) {
    const [y, m, d] = trimmed.split("-").map(Number);
    return new Date(y, m - 1, d).getTime() < todayStart;
  }
  if (US_DATE_ONLY.test(trimmed)) {
    const [m, d, y] = trimmed.split("/").map(Number);
    return new Date(y, m - 1, d).getTime() < todayStart;
  }
  const t = Date.parse(trimmed);
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
