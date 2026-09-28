import type { Match, OpportunityMap } from "./types";

/** Verify/adjacent boundary, pulled out of lib/match.ts's CALIBRATION so this
 *  module has no server-only dependency (lib/corpus/pastAwards.ts needs it via
 *  strongAndVerifying without pulling in match.ts's node:fs/llm/embeddings
 *  chain). match.ts's CALIBRATION.scoreFloor re-exports this same value. */
export const scoreFloor = 33;

/** Shared with lib/match.ts (buildOpportunityMap) and lib/corpus/pastAwards.ts
 *  (dropPastAwardMatches, which rebuilds a cached/precomputed map's summary
 *  the same way after filtering matches, so a past-award match can never
 *  linger in either field). */
export function strongAndVerifying(
  matches: Match[],
  discernment: boolean,
): { strong: Match[]; verifying: Match[] } {
  // "Strong" = the headline high-potential set. Under discernment that's the
  // matches we actually RECOMMEND; otherwise the legacy score>=scoreFloor set.
  const strong = discernment
    ? matches.filter((m) => m.recommendation?.recommendation === "recommend")
    : matches.filter((m) => m.score >= scoreFloor);
  const verifying = discernment
    ? matches.filter((m) => m.recommendation?.recommendation === "verify")
    : [];
  return { strong, verifying };
}

export function agencyIntelFor(strong: Match[]): {
  agencies: string[];
  agencyIntelligence: OpportunityMap["agencyIntelligence"];
} {
  const agencies = Array.from(new Set(strong.map((m) => m.opportunity.agency)));
  return {
    agencies,
    agencyIntelligence: agencies.slice(0, 5).map((agency) => ({
      agency,
      why: strong.find((m) => m.opportunity.agency === agency)?.whyFit?.slice(0, 180) ?? "",
      opportunityCount: strong.filter((m) => m.opportunity.agency === agency).length,
    })),
  };
}
