import { z } from "zod";
import { provenanced } from "./primitives";

/**
 * §3.1 — CompanyProfile
 *
 * The enriched description object: raw text, structured extracted fields, the
 * R1 interview answers, and — mandatory on every field — provenance and
 * confidence.
 *
 * Provenance is enforced *structurally*: every field is a `provenanced(...)`
 * wrapper, so a field cannot be present without declaring where it came from.
 * There is no shape of `CompanyProfile` that carries a fact with no provenance.
 * R2, R3, R8 (esp. R8.4 — a `model_inferred` eligibility fact never gates an
 * exclusion), and R6's attest screen all read this.
 *
 * This is the v2 profile. It is deliberately distinct from the v1
 * `StartupProfile` (see `opportunityMap.ts`), which stays as-is so the live
 * pipeline keeps compiling. Team Interview/Eligibility build against this one.
 */

/** Legal entity type — the most common categorical eligibility gate (R8.1). */
export const EntityTypeSchema = z.enum([
  "for_profit_small_business",
  "for_profit_other",
  "nonprofit",
  "higher_education",
  "state_or_local_government",
  "tribal",
  "individual",
  "other",
]);
export type EntityType = z.infer<typeof EntityTypeSchema>;

/** Federal small-business / socioeconomic certifications (R8.1, R3). */
export const CertificationSchema = z.enum([
  "small_business",
  "sdb", // Small Disadvantaged Business
  "wosb", // Woman-Owned Small Business
  "hubzone",
  "8a",
  "vosb", // Veteran-Owned Small Business
  "sdvosb", // Service-Disabled Veteran-Owned Small Business
]);
export type Certification = z.infer<typeof CertificationSchema>;

/**
 * A single R1 interview answer. The answer value carries its own provenance
 * (nearly always `user_stated`, but a skipped-then-inferred answer is
 * `model_inferred`).
 */
export const InterviewAnswerSchema = z.object({
  question_id: z.string(),
  question: z.string(),
  /** Structured selection(s) and/or the free-text escape hatch (R1). */
  answer: provenanced(z.union([z.string(), z.array(z.string())])),
  skipped: z.boolean().default(false),
});
export type InterviewAnswer = z.infer<typeof InterviewAnswerSchema>;

export const CompanyProfileSchema = z.object({
  /** Stable id so a Run (§3.12) can reference the exact profile it read. */
  id: z.string(),

  /**
   * The user's own description. Provenanced like everything else; it is
   * `user_stated` when typed, `model_inferred`/`verified` after an R3 rewrite.
   */
  raw_text: provenanced(z.string()),

  // --- Structured extracted / interview fields. Each is optional at the
  // --- profile level (may be unknown), but if present it MUST carry provenance.
  entity_type: provenanced(EntityTypeSchema).optional(),
  us_owned: provenanced(z.boolean()).optional(),
  employee_count: provenanced(z.number().int().nonnegative()).optional(),
  location: provenanced(z.string()).optional(),
  /** Geographic designations that gate programs (HUBZone, rural, etc.). */
  geography_designations: provenanced(z.array(z.string())).optional(),
  certifications: provenanced(z.array(CertificationSchema)).optional(),

  /** Registration prerequisites (R8.1) — blockers on the timeline. */
  sam_registered: provenanced(z.boolean()).optional(),
  uei: provenanced(z.string()).optional(),

  industry: provenanced(z.string()).optional(),
  technology: provenanced(z.string()).optional(),
  /** Technology Readiness Level, 1..9 (R1 routing, R8 program gates). */
  trl: provenanced(z.number().int().min(1).max(9)).optional(),
  naics_codes: provenanced(z.array(z.string())).optional(),

  funding_stage: provenanced(z.string()).optional(),
  revenue: provenanced(z.string()).optional(),
  capital_raised: provenanced(z.string()).optional(),
  capital_requirement: provenanced(z.string()).optional(),
  use_of_funds: provenanced(z.string()).optional(),
  rd_activities: provenanced(z.string()).optional(),
  product_maturity: provenanced(z.string()).optional(),
  target_customers: provenanced(z.string()).optional(),
  /** Prior federal awards — a Phase-II prerequisite check for SBIR/STTR (R8.1). */
  prior_federal_funding: provenanced(z.boolean()).optional(),

  /** Government-vocabulary expansion of the user's own words (feeds retrieval). */
  expanded_terms: provenanced(z.array(z.string())).optional(),

  /** The R1 interview transcript. */
  interview_answers: z.array(InterviewAnswerSchema).default([]),
});
export type CompanyProfile = z.infer<typeof CompanyProfileSchema>;

// ---------------------------------------------------------------------------
// §3.1a — Profile field metadata (B1a: required/optional + interview inputs)
// ---------------------------------------------------------------------------
//
// The CompanyProfileSchema above stays deliberately PERMISSIVE — every
// structured cell is a free `provenanced(...)` value so an extractor, a lookup,
// or a user answer can all land there without fighting the shape. This
// companion metadata layer sits *beside* that schema and says, per field:
//
//   - how MATERIAL the field is to routing (required / material / optional), and
//   - how the R1 gap-interview should COLLECT it (input type + enum choices).
//
// It adds NO fields to the contract and changes NO field type, so mergeAnswers
// (INT-02) keeps validating against the permissive schema unchanged. Enum
// choices here are the interview's *offered* options; the stored value stays a
// plain string, so a user's free-text escape is never lost. Gap-detection
// (see `lib/interview/generateQuestions.ts`) reads this to ask only the missing
// material fields and never re-ask one the profile already provides.

/**
 * How material a field is to WHICH PROGRAMS MATCH.
 * - `required` — the search needs it; a gap here should be asked first.
 * - `material` — optional, but its value changes routing/eligibility, so a gap
 *   is worth an interview question.
 * - `optional` — neither; never manufactured into an interview question.
 */
export type ProfileFieldRequirement = "required" | "material" | "optional";

/** How the R1 interview collects a field's value. */
export type ProfileFieldInputType =
  | "free_text" // open-ended prose
  | "integer" // a non-negative whole number
  | "boolean" // yes / no
  | "boolean_text" // yes / no plus an optional free-text elaboration
  | "single_select" // pick exactly one enumerated option
  | "range_select"; // pick exactly one ordered bucket (a coarse numeric range)

/** One offered choice for a `single_select` / `range_select` field. */
export interface ProfileFieldOption {
  value: string;
  label: string;
}

/** Ordered annual-revenue buckets (coarse; the bucket `value` is what's stored). */
export const REVENUE_RANGES: readonly ProfileFieldOption[] = [
  { value: "pre_revenue", label: "Pre-revenue" },
  { value: "under_100k", label: "Under $100K" },
  { value: "100k_1m", label: "$100K–$1M" },
  { value: "1m_10m", label: "$1M–$10M" },
  { value: "over_10m", label: "Over $10M" },
] as const;

/** Ordered "capital raised to date" buckets. */
export const CAPITAL_RAISED_RANGES: readonly ProfileFieldOption[] = [
  { value: "none", label: "None / bootstrapped" },
  { value: "under_250k", label: "Under $250K" },
  { value: "250k_1m", label: "$250K–$1M" },
  { value: "1m_5m", label: "$1M–$5M" },
  { value: "over_5m", label: "Over $5M" },
] as const;

/** Ordered "capital required for this raise" buckets. */
export const CAPITAL_REQUIREMENT_RANGES: readonly ProfileFieldOption[] = [
  { value: "under_250k", label: "Under $250K" },
  { value: "250k_1m", label: "$250K–$1M" },
  { value: "1m_5m", label: "$1M–$5M" },
  { value: "over_5m", label: "Over $5M" },
] as const;

/** Funding-stage choices. */
export const FUNDING_STAGES: readonly ProfileFieldOption[] = [
  { value: "idea", label: "Idea / concept" },
  { value: "pre_seed", label: "Pre-seed" },
  { value: "seed", label: "Seed" },
  { value: "series_a", label: "Series A" },
  { value: "series_b_plus", label: "Series B or later" },
  { value: "bootstrapped", label: "Bootstrapped / revenue-funded" },
] as const;

/** Product-maturity choices (roughly maps onto TRL but user-facing). */
export const PRODUCT_MATURITY_LEVELS: readonly ProfileFieldOption[] = [
  { value: "concept", label: "Concept" },
  { value: "prototype", label: "Prototype" },
  { value: "mvp", label: "MVP" },
  { value: "beta", label: "Beta / pilot" },
  { value: "in_market", label: "In market" },
  { value: "scaling", label: "Scaling" },
] as const;

/** The metadata record for a single CompanyProfile field. */
export interface ProfileFieldMeta {
  /** The `CompanyProfile` field key this describes. */
  field: string;
  /** How material the field is to routing. */
  requirement: ProfileFieldRequirement;
  /** How the R1 interview collects the value. */
  inputType: ProfileFieldInputType;
  /** User-facing short label. */
  label: string;
  /** Offered choices for `single_select` / `range_select`; omitted otherwise. */
  options?: readonly ProfileFieldOption[];
}

/**
 * The 13 fields the R1 interview cares about, in ask-order (required first,
 * then material). `optional`-tier profile fields (entity_type, uei, …) are
 * deliberately absent: they are gated/verified elsewhere, not manufactured into
 * the user gap-interview. Field keys match `CompanyProfileSchema` exactly;
 * `raw_text` is the user's own description.
 */
export const PROFILE_FIELD_META: readonly ProfileFieldMeta[] = [
  // --- REQUIRED — the search needs these to route at all. ---
  { field: "raw_text", requirement: "required", inputType: "free_text", label: "Company description" },
  { field: "industry", requirement: "required", inputType: "free_text", label: "Industry / market" },
  { field: "technology", requirement: "required", inputType: "free_text", label: "Core technology" },
  { field: "location", requirement: "required", inputType: "free_text", label: "Primary US location" },
  { field: "use_of_funds", requirement: "required", inputType: "free_text", label: "Use of funds" },

  // --- OPTIONAL-but-MATERIAL — each changes which programs match. ---
  { field: "employee_count", requirement: "material", inputType: "integer", label: "Team size (full-time employees)" },
  { field: "revenue", requirement: "material", inputType: "range_select", label: "Annual revenue", options: REVENUE_RANGES },
  { field: "funding_stage", requirement: "material", inputType: "single_select", label: "Funding stage", options: FUNDING_STAGES },
  { field: "capital_raised", requirement: "material", inputType: "range_select", label: "Capital raised to date", options: CAPITAL_RAISED_RANGES },
  { field: "rd_activities", requirement: "material", inputType: "boolean_text", label: "R&D activities" },
  { field: "product_maturity", requirement: "material", inputType: "single_select", label: "Product maturity", options: PRODUCT_MATURITY_LEVELS },
  { field: "target_customers", requirement: "material", inputType: "free_text", label: "Target customers" },
  { field: "capital_requirement", requirement: "material", inputType: "range_select", label: "Capital required", options: CAPITAL_REQUIREMENT_RANGES },
];

/** Field-key → metadata lookup, derived from `PROFILE_FIELD_META`. */
export const PROFILE_FIELD_META_BY_KEY: Readonly<Record<string, ProfileFieldMeta>> =
  Object.fromEntries(PROFILE_FIELD_META.map((m) => [m.field, m]));

/**
 * The required + material fields — the ONLY fields the R1 gap-interview may ask
 * about. `optional`-tier fields are excluded by construction.
 */
export const MATERIAL_PROFILE_FIELDS: readonly ProfileFieldMeta[] =
  PROFILE_FIELD_META.filter((m) => m.requirement !== "optional");

/**
 * Whether `profile` already provides a usable value for `field`.
 *
 * A provenanced cell counts as provided only when its `.value` is present and
 * non-empty — a blank/whitespace string or an empty array is NOT provided, so a
 * skipped-then-blank field stays a gap. Fields absent from the object, or that
 * don't carry a `{ value }` cell, are never provided. This is the single atom
 * gap-detection is built on, so the "never re-ask a provided field" guarantee
 * has exactly one definition of "provided".
 */
export function isFieldProvided(
  profile: Partial<CompanyProfile> | Record<string, unknown>,
  field: string,
): boolean {
  const cell = (profile as Record<string, unknown>)[field];
  if (cell == null || typeof cell !== "object") return false;
  const value = (cell as { value?: unknown }).value;
  if (value == null) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return true; // numbers, booleans, and other present scalars count as provided
}

// Provenance primitives (`Provenance`, `Provenanced`, etc.) live in
// `./primitives` and are surfaced through the barrel `index.ts` — imported
// above only for use here, not re-exported (keeps a single export origin).
