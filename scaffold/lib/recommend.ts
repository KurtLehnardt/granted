import type { OpportunityKind } from "./contracts/opportunity";
import type {
  CriterionCheck,
  Recommendation,
  RecommendationResult,
  MapVerdict,
} from "./contracts/opportunityMap";

// Re-export the wire types (defined once in the contract) for ergonomic imports.
export type { Recommendation, RecommendationResult, MapVerdict };

/**
 * Discernment layer (flag `discernment_layer`, default OFF) — the advisory
 * "should I even apply?" verdict, per matching-discernment-spec.md §1/§2/§4.
 *
 * PURE: no LLM, no network, no flag reads. It reinterprets an ALREADY-computed
 * score + the model's OWN met-criteria flags + any USER-STATED disqualifier
 * into a recommend / verify / do_not_recommend verdict. It never changes a
 * score, never derives "don't apply" from a model-INFERRED exclusion (R8.4), and
 * is framed as advisory — never a definitive eligibility ruling.
 *
 * Thresholds are the AGGRESSIVE variant (product decision): a higher bar to earn
 * "worth pursuing" and a quicker "we don't recommend applying," so a user is
 * steered away from marginal/weak applications rather than toward a wall of
 * amber "maybe" cards.
 */

/**
 * Per-kind score a match must clear to be RECOMMENDED (not merely surfaced).
 * Non-grant instruments are held HIGHER: a loan/scholarship/procurement is a
 * weaker "you may win money" signal than a grant at the same score, so it must
 * be genuinely strong before it reads as "worth pursuing." These feed ONLY the
 * recommend decision + the high-potential count; they never change tierFromScore
 * and never hide a match (an over-floor non-grant simply renders as `verify`).
 */
export const RECOMMEND_FLOOR: Record<OpportunityKind, number> = {
  grant: 52,
  rd: 52,
  assistance: 62,
  procurement: 65,
  loan: 66,
  scholarship: 66,
};

/** Below this adjusted score we actively advise against applying (aggressive). */
export const DO_NOT_RECOMMEND_BELOW = 40;
/** Fewer than this share of the program's criteria met → do_not_recommend. */
export const CRITERIA_MIN_ANY = 0.4;
/** A recommend needs at least this share of criteria met (on top of the floor). */
export const CRITERIA_MIN_RECOMMEND = 0.6;

export interface RecommendInput {
  /** The (variance-reduced, when available) fit score, 0–100. */
  adjustedScore: number;
  kind: OpportunityKind;
  /** The model's own program-officer checks; `met` flags turn into a signal. */
  criteria: CriterionCheck[];
  /**
   * TRUE only when a hard eligibility mismatch is stated BY THE USER (never a
   * model-inferred one — R8.4). Rare; the score path does most of the work.
   */
  statedDisqualifier?: boolean;
}

/** Share of criteria the model marked `met`. No criteria → 0 (conservative). */
export function criteriaMetRatio(criteria: CriterionCheck[]): number {
  if (!criteria || criteria.length === 0) return 0;
  return criteria.filter((c) => c.met).length / criteria.length;
}

function metCounts(criteria: CriterionCheck[]): { met: number; total: number } {
  const total = criteria?.length ?? 0;
  const met = total ? criteria.filter((c) => c.met).length : 0;
  return { met, total };
}

/**
 * The advisory verdict for one match. Evaluate top-to-bottom; first match wins.
 */
export function recommendFor(input: RecommendInput): RecommendationResult {
  const ratio = criteriaMetRatio(input.criteria);
  const floor = RECOMMEND_FLOOR[input.kind] ?? RECOMMEND_FLOOR.grant;
  const { met, total } = metCounts(input.criteria);
  // H6 — `criteria: []` (total === 0) is NOT a negative signal. It happens
  // legitimately on the score-only two-pass path (by design — Pass A never
  // produces criteria) and whenever every criterion entry was dropped as
  // malformed (lib/claude.ts's `coerceCriteria`). Either way it means "we
  // have no criteria information," not "the criteria say this is a bad
  // fit." Without this guard, `ratio` is 0 for an empty array, which always
  // clears below `CRITERIA_MIN_ANY` and reports a high-scoring opportunity
  // with no criteria data at all as `do_not_recommend` — a confident wrong
  // answer. `hasCriteriaSignal` gates the criteria-ratio branches below so a
  // missing signal degrades to an honest `verify` instead.
  const hasCriteriaSignal = total > 0;

  // 1. Do-not-recommend: below the fit floor, too few criteria met, or a
  //    USER-STATED hard mismatch (advisory caveat, never a model exclusion).
  if (input.statedDisqualifier === true) {
    return {
      recommendation: "do_not_recommend",
      label: "Not a fit — we don't recommend applying",
      basis:
        "You told us about a requirement this kind of program generally excludes — " +
        "confirm directly with the program officer before investing any time.",
    };
  }
  if (input.adjustedScore < DO_NOT_RECOMMEND_BELOW) {
    return {
      recommendation: "do_not_recommend",
      label: "Not a fit — we don't recommend applying",
      basis: "This scores below our fit bar for this kind of program — an application is unlikely to be productive.",
    };
  }
  if (hasCriteriaSignal && ratio < CRITERIA_MIN_ANY) {
    return {
      recommendation: "do_not_recommend",
      label: "Not a fit — we don't recommend applying",
      basis: `This meets only ${met} of ${total} of the program's own criteria — it doesn't match how this program funds work.`,
    };
  }

  // 2. Recommend: strong on BOTH score and criteria, no stated caveat.
  if (hasCriteriaSignal && input.adjustedScore >= floor && ratio >= CRITERIA_MIN_RECOMMEND) {
    return {
      recommendation: "recommend",
      label: "Strong fit — worth pursuing",
      basis: `Strong alignment on both fit and mechanism (${met} of ${total} program criteria met).`,
    };
  }

  // 3. No criteria signal at all (and not already caught by a stated
  //    disqualifier or the score floor above): an honest "verify," not a
  //    confident negative — see the H6 note on `hasCriteriaSignal` above.
  if (!hasCriteriaSignal) {
    return {
      recommendation: "verify",
      label: "Marginal — verify before investing time",
      basis: "No detailed program criteria were available for this match — verify fit directly before investing time.",
    };
  }

  // 4. Verify: the honest middle — a real but partial or uncertain fit.
  return {
    recommendation: "verify",
    label: "Marginal — verify before investing time",
    basis: `A real but partial fit (${met} of ${total} program criteria met) — worth pursuing only if the open criteria check out.`,
  };
}

/**
 * The whole-map verdict (§2), decoupling the honest-no from "zero clear the
 * floor." One lucky marginal yields `thin_map` ("even our best is a stretch"),
 * not a confident list.
 */
export function mapVerdict(args: {
  recommendCount: number;
  verifyCount: number;
  maxScore: number;
}): MapVerdict {
  if (args.recommendCount >= 1) return "strong_map";
  if (args.verifyCount >= 1 || args.maxScore >= DO_NOT_RECOMMEND_BELOW) return "thin_map";
  return "no_fit";
}
