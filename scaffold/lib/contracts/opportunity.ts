import { z } from "zod";
import { CitationSchema, ProvenanceSchema } from "./primitives";

/**
 * §3.4 — Opportunity (the normalized program record from the Canon, §4)
 *
 * Design note (important, read before changing):
 * The v1 pipeline (`lib/match.ts`, `lib/claude.ts`, `components/*`) reads a
 * concrete, narrower shape today. To satisfy the hard constraint "the existing
 * app builds unchanged," this contract is an **additive superset** of the v1
 * shape: every field the v1 code touches stays required/optional exactly as it
 * was, and the §3.4 Canon fields (`source_id`, `title`, `status`, `key_dates`,
 * `award_range`, `eligibility_rules`, `retrieved_at`) are added as OPTIONAL.
 *
 * That means:
 *  - Cached `data/precomputed.json` opportunities (v1 shape) still validate.
 *  - Team Canon populates the new optional fields going forward.
 *  - Nothing in the live path changes.
 *
 * v1 → §3.4 field mapping (documented so no one "fixes" it by renaming):
 *   program            ~ title
 *   forecasted/deadline ~ status + key_dates
 *   fundingLow/High     ~ award_range
 *   eligibility (prose) ~ eligibility_rules (structured, with citations)
 */

/** v1 corpus sources + the §4.2 Canon sources. Broad on purpose (superset). */
export const OpportunitySourceSchema = z.enum([
  // v1 values present in the corpus / cached responses:
  "grants.gov",
  "sbir",
  "assistance-listings",
  "sam-contracts",
  // State grant sources:
  "ca-grants",
  "il-grants",
  "nc-grants",
  "ut-grants",
  // §4.2 Canon sources (forward-compatible):
  "sam.gov",
  "sbir.gov",
  "usaspending",
  "agency-feed",
]);
export type OpportunitySource = z.infer<typeof OpportunitySourceSchema>;

/**
 * Sources whose opportunities are FEDERAL financial assistance/procurement —
 * governed by federal regulations (2 CFR SAM.gov registration, the FAR, SBA
 * loan rules, etc.). State-grant sources (`ca-grants`/`il-grants`/`nc-grants`)
 * are explicitly NOT federal and must never be shown federal-only
 * requirements (SAM.gov/UEI registration, SBA "organized for profit," etc.).
 *
 * Single source of truth for this distinction — both
 * `components/ApplicationChecklist.tsx` (the document checklist / next-steps
 * copy) and `lib/eligibility/universalRules.ts` (the ELG-01 eligibility
 * screening engine's federal regulatory overlay) import this rather than
 * keeping their own copies. They drifted apart once already: #260 added the
 * `ApplicationChecklist.tsx` gate when state sources shipped, but
 * `universalRules.ts`'s sibling engine wasn't updated at the same time, so it
 * kept showing a SAM.gov/UEI "authority" requirement on every state grant —
 * a real, reported bug. `agency-feed` is deliberately left out: its
 * federal-ness is unconfirmed (§4.2, forward-compatible placeholder), and
 * the safe failure direction here is to under-apply a federal rule, never
 * to over-apply one to a non-federal program.
 */
export const FEDERAL_SOURCES: ReadonlySet<OpportunitySource> = new Set<OpportunitySource>([
  "grants.gov",
  "sbir",
  "sbir.gov",
  "assistance-listings",
  "sam.gov",
  "sam-contracts",
  "usaspending",
]);

/**
 * The *instrument* an opportunity offers, independent of its `source`. Broad on
 * purpose so the corpus can carry the full spread of federal/adjacent programs:
 *   grant       — non-repayable award (Grants.gov, assistance listings)
 *   rd          — research & development contract/award (this is how SBIR/STTR
 *                 is modeled: `source:"sbir"` + `kind:"rd"` — there is
 *                 deliberately NO `sbir` kind; the program is a source, its
 *                 instrument is R&D)
 *   assistance  — assistance-listings program (CFDA-style)
 *   procurement — a purchase/contract (SAM contracts)
 *   loan        — repayable capital (e.g. SBA/USDA loan & loan-guarantee programs)
 *   scholarship — individual educational award (fellowships, scholarships)
 */
export const OpportunityKindSchema = z.enum([
  "grant",
  "rd",
  "assistance",
  "procurement",
  "loan",
  "scholarship",
]);
export type OpportunityKind = z.infer<typeof OpportunityKindSchema>;

/**
 * Program status (R8.3 freshness). Rolling/continuous/standing programs are a
 * first-class status, not forced into a deadline model.
 */
export const OpportunityStatusSchema = z.enum([
  "forecasted",
  "open",
  "closed",
  "rolling",
  "continuous",
  "standing",
  "unknown",
]);
export type OpportunityStatus = z.infer<typeof OpportunityStatusSchema>;

/** Categories of hard eligibility gate (R8.1). */
export const EligibilityRuleCategorySchema = z.enum([
  "entity_type",
  "size_ownership",
  "registration",
  "geography",
  "program_specific",
  "other",
]);
export type EligibilityRuleCategory = z.infer<
  typeof EligibilityRuleCategorySchema
>;

/**
 * A structured, cited eligibility rule (R8.4 — "Rules live in the Canon, not in
 * model recall"). `provenance` is required: a `model_inferred` rule is never
 * sufficient to exclude an opportunity until reviewed.
 */
export const EligibilityRuleSchema = z.object({
  id: z.string(),
  category: EligibilityRuleCategorySchema,
  /** Human-readable statement of the rule. */
  description: z.string(),
  /** Where the rule came from — mandatory for a rule to gate anything (R8.4). */
  citation: CitationSchema,
  provenance: ProvenanceSchema,
});
export type EligibilityRule = z.infer<typeof EligibilityRuleSchema>;

export const KeyDatesSchema = z.object({
  open_date: z.string().datetime().optional(),
  close_date: z.string().datetime().optional(),
  response_date: z.string().datetime().optional(),
});
export type KeyDates = z.infer<typeof KeyDatesSchema>;

export const AwardRangeSchema = z.object({
  floor: z.number().nonnegative().optional(),
  ceiling: z.number().nonnegative().optional(),
  currency: z.string().default("USD"),
});
export type AwardRange = z.infer<typeof AwardRangeSchema>;

export const OpportunitySchema = z.object({
  // --- v1 base (unchanged; the live pipeline reads these) ---
  id: z.string(),
  source: OpportunitySourceSchema,
  kind: OpportunityKindSchema,
  program: z.string(),
  agency: z.string(),
  description: z.string(),
  eligibility: z.string().optional(),
  fundingLow: z.number().optional(),
  fundingHigh: z.number().optional(),
  deadline: z.string().optional(),
  forecasted: z.boolean().optional(),
  industryTags: z.array(z.string()).optional(),
  geography: z.string().optional(),
  url: z.string().optional(),
  embedding: z.array(z.number()).optional(),

  // --- §3.4 Canon additions (all optional → additive, cache-safe) ---
  /** Stable id within the source system (Grants.gov opp number, SBIR topic). */
  source_id: z.string().optional(),
  /** Canonical title (v1 uses `program`). */
  title: z.string().optional(),
  status: OpportunityStatusSchema.optional(),
  key_dates: KeyDatesSchema.optional(),
  award_range: AwardRangeSchema.optional(),
  /** Structured, cited eligibility rules (R8). */
  eligibility_rules: z.array(EligibilityRuleSchema).optional(),
  /** ISO-8601 retrieval timestamp (R8.3 / §4.4 freshness). */
  retrieved_at: z.string().datetime().optional(),
  /** Canon snapshot this record came from (§4.3 / R10.2 reproducibility). */
  corpus_version: z.string().optional(),
});
export type Opportunity = z.infer<typeof OpportunitySchema>;
