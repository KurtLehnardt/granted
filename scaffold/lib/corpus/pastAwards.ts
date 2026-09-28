import type { Opportunity, OpportunityMap } from "../types";
import { mapVerdict } from "../recommend";
import { strongAndVerifying, agencyIntelFor } from "../summary";

type AwardShape = Pick<Opportunity, "source" | "id"> & { status?: string };

/** Past awards (SBIR/STTR award records, closed USAspending contracts) are never
 *  matches; award history and competitor analysis cover them. Open SBIR/STTR
 *  solicitations share source "sbir" but not the "sbir-award-" id prefix. */
export function isPastAward(o: AwardShape): boolean {
  if (o.source === "sbir" && o.id.startsWith("sbir-award-")) return true;
  return o.source === "usaspending" && o.status === "closed";
}

export function dropPastAwards<T extends AwardShape>(opportunities: T[]): T[] {
  return opportunities.filter((o) => !isPastAward(o));
}

/** Strips past-award matches from a stored map and rebuilds what lib/match.ts derives from them. */
export function dropPastAwardMatches(map: OpportunityMap, now: number = Date.now()): OpportunityMap {
  const matches = map.matches.filter((m) => !isPastAward(m.opportunity));
  const closingIn90Days = matches.filter((m) => {
    const d = m.opportunity.deadline ? Date.parse(m.opportunity.deadline) : NaN;
    return !Number.isNaN(d) && d > now && d - now < 90 * 864e5;
  }).length;
  const discernment = map.matches.some((m) => m.recommendation != null);
  const { strong, verifying } = strongAndVerifying(matches, discernment);
  const { agencies, agencyIntelligence } = agencyIntelFor(strong);
  const verdict = map.mapVerdict
    ? mapVerdict({
        recommendCount: strong.length,
        verifyCount: verifying.length,
        maxScore: matches.reduce((mx, m) => Math.max(mx, m.score), 0),
      })
    : undefined;
  return {
    ...map,
    matches,
    summary: {
      ...map.summary,
      highPotential: strong.length,
      ...(discernment ? { worthVerifying: verifying.length } : {}),
      fundingIdentified: strong.reduce((sum, m) => sum + (m.opportunity.fundingHigh ?? 0), 0),
      agencies: agencies.length,
      closingIn90Days,
    },
    ...(verdict ? { mapVerdict: verdict } : {}),
    agencyIntelligence,
  };
}
