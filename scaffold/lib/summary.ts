import type { Match, OpportunityMap } from "./types";

/** Verify/adjacent boundary; see CALIBRATION.scoreFloor in lib/match.ts. Kept here so client code can import it. */
export const scoreFloor = 33;

/** "Strong" is the recommended set under discernment, else score >= scoreFloor. */
export function strongAndVerifying(
  matches: Match[],
  discernment: boolean,
): { strong: Match[]; verifying: Match[] } {
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
