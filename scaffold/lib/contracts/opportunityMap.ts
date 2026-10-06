import { z } from "zod";
import { OpportunitySchema } from "./opportunity";
import { EligibilityDeterminationSchema } from "./eligibilityDetermination";

/**
 * §3.6 — OpportunityMap (the existing v1 output schema, formalized + versioned)
 *
 * This formalizes the exact shape `lib/match.ts` `buildOpportunityMap()`
 * returns today and the shape frozen into `data/precomputed.json`, RECONCILED
 * (schema-reconcile) against what the live builder actually produces:
 *
 *   1. Two ADDITIVE fields the live map carries that v1 never declared —
 *      `matches[].eligibility` (ELG-04) and top-level `costDebug` (R4b) — are
 *      now declared as OPTIONAL fields (see `EligibilityDeterminationWithFreshnessSchema`
 *      and `SearchCostDebugSchema` below). Optional keeps cached/precomputed
 *      maps, which lack both, still validating (CON-01's "additive, must not
 *      break the cached responses").
 *   2. The narrative `Match` strings (`whyFit`, `whyIneligible`,
 *      `whatToVerify`, `whatToDoNext`, and — as of C2 — `whyCare`) were
 *      `z.string()` (required), but `lib/match.ts` assigns them straight from
 *      an unvalidated LLM JSON response (`parseJson()` in `lib/claude.ts` is a
 *      raw `JSON.parse` + cast — no zod backstop), so any of them can
 *      legitimately be `undefined` on a real map (e.g. a clear-fit match the
 *      model judged to have nothing "ineligible" to report). Reproduced
 *      directly against `MatchSchema`: all fail identically when omitted.
 *      They are display strings, not eligibility gates, so they now
 *      `.default("")` instead of being required — present-as-string for
 *      consumers, but no longer a validation failure on a real live map.
 *
 * Why `version` is optional, not defaulted-to-required: the cached responses in
 * `data/precomputed.json` have no `version` field, and `lib/match.ts` returns
 * objects with no `version`. Making it optional keeps both compiling/parsing
 * unchanged while still giving producers a place to stamp the version. This is
 * the "additive, must not break the cached responses" requirement from CON-01.
 *
 * The v1 supporting types (`Tier`, `StartupProfile`, `CriterionCheck`,
 * `AwardHistory`, `Match`) live here because they are only meaningful as parts
 * of this output schema. NOTE: the tier *label/colour* maps (`TIER_LABEL`,
 * `TIER_COLOR`) are design values and intentionally do NOT live in
 * `lib/contracts/` (CON-01 forbids raw hex here — that is CON-02). They stay in
 * `lib/types.ts`.
 */

export const CURRENT_OPPORTUNITY_MAP_VERSION = "1.0.0";

export const TierSchema = z.enum(["likely", "verify", "adjacent", "none"]);
export type Tier = z.infer<typeof TierSchema>;

/**
 * v1 profile. Distinct from the v2 §3.1 `CompanyProfile`: this is the ad-hoc
 * shape the live pipeline extracts and passes around. Kept verbatim so
 * `lib/match.ts` / `lib/claude.ts` compile unchanged.
 */
export const StartupProfileSchema = z.object({
  description: z.string(),
  industry: z.string().optional(),
  technology: z.string().optional(),
  location: z.string().optional(),
  employees: z.number().optional(),
  revenue: z.string().optional(),
  fundingStage: z.string().optional(),
  capitalRaised: z.string().optional(),
  rdActivities: z.string().optional(),
  productMaturity: z.string().optional(),
  targetCustomers: z.string().optional(),
  capitalRequirement: z.string().optional(),
  useOfFunds: z.string().optional(),
  expandedTerms: z.array(z.string()).optional(),
  naicsGuesses: z.array(z.string()).optional(),
});
export type StartupProfile = z.infer<typeof StartupProfileSchema>;

export const CriterionCheckSchema = z.object({
  label: z.string(),
  met: z.boolean(),
  note: z.string().optional(),
});
export type CriterionCheck = z.infer<typeof CriterionCheckSchema>;

export const AwardHistorySchema = z.object({
  similarCompanies: z.number(),
  totalAwarded: z.number(),
  medianAward: z.number(),
  inState: z.number(),
  inVertical: z.number(),
  /**
   * A3-lite (provenance gate) — `sourceUrl` is a real SBIR.gov awards link
   * (`https://www.sbir.gov/awards?company_name=<firm>`) proving this specific award
   * was cross-checked against the live SBIR bulk award CSV
   * (`data.www.sbir.gov/mod_awarddatapublic_no_abstract/...`). Every row
   * written to `data/awards.json` now carries one — unverifiable rows were
   * dropped from the data file entirely rather than kept without it.
   *
   * OPTIONAL here, not required: same CON-01 "additive, must not break the
   * cached responses" reasoning as `version`/`eligibility`/`costDebug` above
   * — `data/precomputed.json`'s cached maps predate this field and must keep
   * validating unchanged (that file is out of scope for this change). The
   * actual suppression guarantee does NOT live in this schema being strict;
   * it lives in `historyFromRows()` (`lib/match.ts`), which FILTERS rows to
   * only those with a non-empty `sourceUrl` before a recipient ever reaches
   * this shape — an unverifiable company is filtered out upstream, long
   * before validation, so it can never reach a live map regardless of what
   * this field's optionality allows through for old cached data.
   */
  recipients: z.array(
    z.object({
      company: z.string(),
      program: z.string(),
      agency: z.string(),
      amount: z.number(),
      year: z.number(),
      sourceUrl: z.string().optional(),
    }),
  ),
  /**
   * True when this opportunity has no verified award history of its own and
   * these are instead companies the SAME AGENCY has funded elsewhere in the
   * corpus (lib/match.ts's historyForAgency fallback) — a different, broader
   * claim than "funded under this exact program." Optional/absent (not
   * `false`) for the direct-match case, so cached/precomputed maps built
   * before this field existed keep validating unchanged.
   */
  fromAgency: z.literal(true).optional(),
  /**
   * Canonical display name of the state `inState` was computed against
   * (e.g. "Texas"), derived from the company's free-text location via
   * `lib/location.ts`'s `normalizeStateName`. Absent when that location
   * didn't resolve to a known state — never a guessed/default state.
   * Optional/absent for cached/precomputed maps built before this field
   * existed, same reasoning as `fromAgency` above.
   */
  inStateLabel: z.string().optional(),
});
export type AwardHistory = z.infer<typeof AwardHistorySchema>;

/**
 * ELG-02 — `FreshnessAnnotation`, mirrored from `lib/eligibility/freshness.ts`'s
 * interface of the same name. Exact field-for-field match (not a passthrough):
 * that module is pure/stable and this schema is cheap to keep in sync with it.
 */
export const FreshnessAnnotationSchema = z.object({
  data_as_of: z.string().nullable(),
  is_stale: z.boolean(),
  caveat: z.string().nullable(),
  assessed_at: z.string(),
});

/**
 * ELG-04 — `EligibilityDeterminationWithFreshness`, mirrored from
 * `lib/eligibility/freshness.ts`. `determination` reuses the existing
 * `EligibilityDeterminationSchema` (§3.5) verbatim — including its R8.2/R8.4
 * anti-fabrication `.refine()`s — rather than a loose/passthrough shape, so an
 * attached `eligibility` is validated exactly as strictly as `screen()`'s own
 * `EligibilityDeterminationSchema.parse()` backstop validates it upstream
 * (`lib/eligibility/screen.ts`). No anti-fabrication guarantee is weakened by
 * declaring this field: it is additive-optional so maps without it (cached/
 * precomputed) still validate, and maps WITH it get the full determination
 * validation for free.
 */
export const EligibilityDeterminationWithFreshnessSchema = z.object({
  determination: EligibilityDeterminationSchema,
  freshness: FreshnessAnnotationSchema,
});

/**
 * DISC (flag `discernment_layer`) — the ADVISORY per-match verdict + whole-map
 * verdict (lib/recommend.ts). Additive + optional so cached/precomputed maps and
 * every flag-off live map (which never carry them) validate unchanged. The
 * recommendation is advisory and NEVER a definitive eligibility ruling (R8.4).
 */
export const RecommendationSchema = z.enum(["recommend", "verify", "do_not_recommend"]);
export type Recommendation = z.infer<typeof RecommendationSchema>;

export const RecommendationResultSchema = z.object({
  recommendation: RecommendationSchema,
  label: z.string(),
  basis: z.string(),
});
export type RecommendationResult = z.infer<typeof RecommendationResultSchema>;

export const MapVerdictSchema = z.enum(["strong_map", "thin_map", "no_fit"]);
export type MapVerdict = z.infer<typeof MapVerdictSchema>;

export const MatchSchema = z.object({
  opportunity: OpportunitySchema,
  tier: TierSchema,
  score: z.number(),
  criteria: z.array(CriterionCheckSchema),
  /** DISC — advisory recommend/verify/do-not-recommend verdict (flag-gated). */
  recommendation: RecommendationResultSchema.optional(),
  // Narrative display strings written by an LLM whose JSON response is never
  // itself schema-validated (`lib/claude.ts` `parseJson()` is a raw parse +
  // cast). A real map can legitimately omit any of these four (e.g. a
  // clear-fit match has nothing "ineligible" to report) — reproduced directly
  // against this schema, see the module doc comment above. `.default("")`
  // keeps them present-as-strings for consumers (cards can render an empty
  // string safely) without making a live map fail boundary validation. These
  // are NOT eligibility gates — `eligibility` below is the sole gated field,
  // and its schema keeps every anti-fabrication refinement intact.
  // C2 — distinct from whyFit: for a grant/rd candidate this is "why you may
  // fit"; for a procurement/adjacent candidate it's "why this matters to
  // you" (government-as-customer strategic value). See the `explainMatches`
  // v2 prompt (lib/prompts/registry.ts) rule 2. Same `.default("")` treatment
  // as the other narrative strings: not schema-validated at the LLM boundary,
  // additive-optional so cached/precomputed maps predating C2 still validate.
  whyCare: z.string().default(""),
  whyFit: z.string().default(""),
  whyIneligible: z.string().default(""),
  whatToVerify: z.string().default(""),
  whatToDoNext: z.string().default(""),
  history: AwardHistorySchema.optional(),
  /**
   * ELG-04 (`lib/types.ts` `Match.eligibility`) — attached by
   * `buildOpportunityMap()` (`lib/match.ts`) for every match, DEFENSIVELY (a
   * screening failure just omits the field for that one match). OPTIONAL so
   * cached/precomputed maps, which predate ELG-04 and never carry it, keep
   * validating unchanged.
   */
  eligibility: EligibilityDeterminationWithFreshnessSchema.optional(),
  /** ANALYZING ring — false while this candidate's score may still change
   *  (not yet scored, or Pass-A scored but Pass-B pending for a promoted
   *  candidate). Optional so cached/precomputed maps (always terminal) and
   *  older clients keep validating; absent is treated as final. */
  final: z.boolean().optional(),
  /** Every provisional id gets a terminal event (§1) — when scoring genuinely
   *  couldn't produce a score for it (a dropped batch, an unresolved id), this
   *  is `true` and the card renders a "Couldn't score" placeholder instead of
   *  a fabricated number. */
  unscored: z.boolean().optional(),
});
export type Match = z.infer<typeof MatchSchema>;

/**
 * R4b — `StageCost` / `SearchCostDebug`, mirrored from `lib/metering/meter.ts`.
 * Loose-but-typed rather than `.passthrough()`: `CostMeter` is internally
 * defensive (never throws, `safeNumber()` coerces bad usage data to `0`) but
 * is NOT itself a validated boundary, and this data never drives any
 * eligibility/exclusion decision — it is purely informational cost telemetry
 * gated behind the `r4b_cost_debug` flag before it ever reaches a client. A
 * mirrored shape (vs. `.passthrough()`) still catches a genuinely malformed
 * `costDebug` at the boundary-validation log line this schema backs.
 */
export const StageCostSchema = z.object({
  stage: z.string(),
  // "builtin" (the in-process search model) and "custom" (a self-hosted embedder) cost nothing.
  provider: z.enum(["anthropic", "openai", "builtin", "custom"]),
  model: z.string(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheCreationInputTokens: z.number().optional(),
  cacheReadInputTokens: z.number().optional(),
  costUsd: z.number(),
  latencyMs: z.number(),
  calls: z.number(),
});

export const SearchCostDebugSchema = z.object({
  stages: z.array(StageCostSchema),
  totalCostUsd: z.number(),
  totalLatencyMs: z.number(),
  pricingAsOf: z.string(),
});

export const OpportunityMapSchema = z.object({
  profile: StartupProfileSchema,
  followUps: z.array(z.string()),
  summary: z.object({
    highPotential: z.number(),
    /**
     * DISC — count of `verify` matches, kept alongside `highPotential` so that
     * recounting high-potential as recommend-only never HIDES the marginal set
     * (honesty, not suppression). Optional; absent when the flag is off.
     */
    worthVerifying: z.number().optional(),
    fundingIdentified: z.number(),
    agencies: z.number(),
    closingIn90Days: z.number(),
  }),
  matches: z.array(MatchSchema),
  /**
   * DISC — the whole-map verdict (strong/thin/no-fit), so a single lucky marginal
   * reads as "even our best is a stretch" rather than a confident list. Optional;
   * absent when `discernment_layer` is off.
   */
  mapVerdict: MapVerdictSchema.optional(),
  /** Set when nothing clears the bar. This is a finding, not a failure. */
  weakFieldFinding: z
    .object({
      headline: z.string(),
      reasoning: z.string(),
      redirects: z.array(z.object({ label: z.string(), why: z.string() })),
    })
    .optional(),
  agencyIntelligence: z.array(
    z.object({
      agency: z.string(),
      why: z.string(),
      opportunityCount: z.number(),
    }),
  ),
  /**
   * Additive version tag (§3.6). Optional so v1 producers and cached responses
   * remain valid; stamp it with `CURRENT_OPPORTUNITY_MAP_VERSION` on new writes.
   */
  version: z.string().optional(),
  /**
   * R4b (`lib/types.ts` `OpportunityMap.costDebug`) — attached by
   * `buildOpportunityMap()`'s `finalizeCost()` (`lib/match.ts`) ONLY when the
   * `r4b_cost_debug` flag is on. OPTIONAL so cached/precomputed maps and every
   * live map with the flag off (the default) keep validating without it.
   */
  costDebug: SearchCostDebugSchema.optional(),
});
export type OpportunityMap = z.infer<typeof OpportunityMapSchema>;
