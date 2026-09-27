import type { Opportunity, OpportunityMap } from "../types";

const ISO_DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const US_DATE_ONLY = /^\d{1,2}\/\d{1,2}\/\d{4}$/;

function startOfLocalDay(t: number): number {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Missing/unparseable deadlines never expire; date-only deadlines stay open through their closing day. */
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

export function dropExpiredOpportunities<T extends { deadline?: unknown }>(
  opportunities: T[],
  now: number = Date.now(),
): T[] {
  return opportunities.filter((o) => !isExpiredDeadline(o.deadline, now));
}

export function dropExpiredMatches(map: OpportunityMap, now: number = Date.now()): OpportunityMap {
  const matches = map.matches.filter((m) => !isExpiredDeadline((m.opportunity as Opportunity).deadline, now));
  const closingIn90Days = matches.filter((m) => {
    const d = m.opportunity.deadline ? Date.parse(m.opportunity.deadline) : NaN;
    return !Number.isNaN(d) && d > now && d - now < 90 * 864e5;
  }).length;
  return { ...map, matches, summary: { ...map.summary, closingIn90Days } };
}
