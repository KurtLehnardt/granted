import { z } from "zod";
import {
  OpportunitySchema,
  EligibilityRuleSchema,
} from "../contracts/opportunity";

/**
 * CanonOpportunity — the store-row type (CAN-01 DoD, from the CON-01 review).
 *
 * WHY THIS LIVES HERE (not in contracts/opportunity.ts):
 * ------------------------------------------------------
 * CON-01's `OpportunitySchema` is an *additive superset* of the v1 shape: every
 * Canon field (`source_id`, `title`, `status`, `key_dates`, `award_range`,
 * `retrieved_at`, `eligibility_rules`) is OPTIONAL so that cached v1 records
 * (`data/precomputed.json`) still validate and the live pipeline is unchanged.
 * That optionality is correct for the *contract* but wrong for a *store row*: a
 * row that Canon wrote must have the structured fields populated, or ELG/FE
 * silently receive `undefined` for status, dates, award range, etc.
 *
 * `CanonOpportunitySchema` is therefore the STRICTER type the store reads/writes:
 * it is `OpportunitySchema` with the Canon fields REQUIRED. It is owned by Team
 * Canon (this file), NOT by the CON-owned contract, so tightening it never
 * breaks the v1 cache-compatibility guarantee CON-01 makes.
 *
 * NORMALIZATION RULE (load-bearing — do not "simplify" writes back onto the v1
 * mirrors):
 *   A Canon write MUST populate the STRUCTURED fields:
 *     - source_id      (not just the composite `id`)
 *     - title          (not just the v1 `program`)
 *     - status         (not just the v1 `forecasted`/`deadline`)
 *     - key_dates      (structured open/close/response; not just `deadline` text)
 *     - award_range    (floor/ceiling/currency; not just `fundingLow`/`fundingHigh`)
 *     - retrieved_at   (freshness — §4.4 / R8.3)
 *     - eligibility_rules (structured array; `[]` until CAN-04 extracts them —
 *                          NEVER left `undefined`, so ELG can branch on length)
 *   The v1 mirrors (`program`, `deadline`, `fundingLow/High`, `eligibility` prose)
 *   are still written for backward compatibility, but they are mirrors of the
 *   structured truth, not the source of it. Downstream reads the structured
 *   fields and can rely on them being present on any store row.
 */
export const CanonOpportunitySchema = OpportunitySchema.required({
  source_id: true,
  title: true,
  status: true,
  key_dates: true,
  award_range: true,
  retrieved_at: true,
}).extend({
  // Required on a store row, but defaults to `[]` — rule EXTRACTION is CAN-04.
  // Present-but-empty (never `undefined`) so ELG can safely read `.length`.
  eligibility_rules: z.array(EligibilityRuleSchema).default([]),
});

export type CanonOpportunity = z.infer<typeof CanonOpportunitySchema>;

/**
 * Parse/validate an unknown value as a CanonOpportunity (throws on failure).
 * Use at the write boundary so a malformed Canon write is caught before it
 * reaches the store.
 */
export function parseCanonOpportunity(value: unknown): CanonOpportunity {
  return CanonOpportunitySchema.parse(value);
}
