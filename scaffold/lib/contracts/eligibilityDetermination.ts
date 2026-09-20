import { z } from "zod";
import { CitationSchema, ProvenanceSchema } from "./primitives";
import { EligibilityRuleCategorySchema } from "./opportunity";

/**
 * §3.5 — EligibilityDetermination
 *
 * `{ opportunity_id, bucket, satisfied_rules[], failed_rules[],
 *    unknown_rules[], required_steps[], rule_source }`. R8 renders directly
 * from this.
 *
 * Every rule reference carries `provenance`, so R8.4 is enforceable at the type
 * level: an exclusion driven by a `model_inferred` rule is detectable (and per
 * R8.4 must not stand until reviewed). Unknown gates go in `unknown_rules`
 * rather than being guessed in either direction (R8.2).
 */

/** The three buckets (R8.2) plus `unknown` for undetermined eligibility. */
export const EligibilityBucketSchema = z.enum([
  "eligible",
  "conditionally_eligible",
  "excluded",
  "unknown",
]);
export type EligibilityBucket = z.infer<typeof EligibilityBucketSchema>;

/**
 * A rule as it was evaluated against the profile. References the Canon rule and
 * records how the fact used to evaluate it was known (provenance) so a
 * `model_inferred` exclusion can never silently stand (R8.4).
 */
export const RuleEvaluationSchema = z.object({
  rule_id: z.string(),
  category: EligibilityRuleCategorySchema,
  /** Human-readable statement of what was checked. */
  description: z.string(),
  /** Provenance of the fact/rule used — gates whether it may drive exclusion. */
  provenance: ProvenanceSchema,
  /** Citation for the rule (R8.4). */
  citation: CitationSchema.optional(),
});
export type RuleEvaluation = z.infer<typeof RuleEvaluationSchema>;

/** A concrete step to reach eligibility (R8.2 "conditionally eligible"). */
export const RequiredStepSchema = z.object({
  step: z.string(),
  /** Lead time the step needs (e.g. SAM.gov registration takes weeks). */
  lead_time_days: z.number().int().nonnegative().optional(),
  why: z.string().optional(),
});
export type RequiredStep = z.infer<typeof RequiredStepSchema>;

export const EligibilityDeterminationSchema = z
  .object({
    opportunity_id: z.string(),
    bucket: EligibilityBucketSchema,
    satisfied_rules: z.array(RuleEvaluationSchema).default([]),
    failed_rules: z.array(RuleEvaluationSchema).default([]),
    /** Gates that could not be determined — rendered as unknown, never guessed. */
    unknown_rules: z.array(RuleEvaluationSchema).default([]),
    required_steps: z.array(RequiredStepSchema).default([]),
    /** Where the governing rules came from (R8.4). */
    rule_source: CitationSchema.optional(),
  })
  /**
   * R8.2 — never a silent/empty exclusion. An `excluded` bucket must name at
   * least one failed rule (the reason is always shown).
   */
  .refine((d) => d.bucket !== "excluded" || d.failed_rules.length > 0, {
    message: "An excluded determination must cite at least one failed rule (R8.2).",
    path: ["failed_rules"],
  })
  /**
   * R8.4 — "A user told they are ineligible on the strength of a
   * hallucinated rule is the worst single failure this product can produce."
   * An exclusion cannot rest ONLY on `model_inferred` rules; at least one
   * failed rule must be `user_stated` or `verified`.
   */
  .refine(
    (d) =>
      d.bucket !== "excluded" ||
      d.failed_rules.some((r) => r.provenance !== "model_inferred"),
    {
      message:
        "An exclusion cannot be driven solely by model_inferred rules (R8.4).",
      path: ["failed_rules"],
    },
  );
export type EligibilityDetermination = z.infer<
  typeof EligibilityDeterminationSchema
>;
