import type { Assessment } from "./twoPass";

/**
 * Hybrid scorer (flag `hybrid_scorer`) — the narrative-only half. The LLM
 * explains a score the DBSF scorer already produced; it never carries a
 * `score` or `tier` of its own.
 */
export interface NarrativeAssessment {
  id: string;
  whyCare: string;
  whyFit: string;
  whyIneligible: string;
  whatToVerify: string;
  whatToDoNext: string;
  criteria: Array<{ label: string; met: boolean; note: string }>;
}

/** Merge narrative fields into a score-only assessment. Never changes the score. */
export function mergeNarrativeIntoAssessment(
  base: Assessment,
  narrative: NarrativeAssessment,
): Assessment {
  return {
    ...base,
    criteria: narrative.criteria,
    whyCare: narrative.whyCare,
    whyFit: narrative.whyFit,
    whyIneligible: narrative.whyIneligible,
    whatToVerify: narrative.whatToVerify,
    whatToDoNext: narrative.whatToDoNext,
  };
}

/** Merge all narratives into DBSF assessments by id. Unmatched assessments keep their score-only form. */
export function mergeHybridResults(
  dbsfAssessments: Assessment[],
  narratives: NarrativeAssessment[],
): Assessment[] {
  const byId = new Map<string, NarrativeAssessment>();
  for (const n of narratives) byId.set(n.id, n);
  return dbsfAssessments.map((a) => {
    const n = byId.get(a.id);
    return n ? mergeNarrativeIntoAssessment(a, n) : a;
  });
}
