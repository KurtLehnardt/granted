import { z } from "zod";
import { FOUNDER_TODO_PATTERN } from "./applicationDraft";

/**
 * VENDORED COPY of `scaffold/lib/contracts/applicationBudget.ts`. Kept
 * byte-for-byte equivalent (see `test/contractDrift.test.ts`). Vendored
 * because `AssembledPackage.budget` (package.ts) is typed `ApplicationBudget`
 * — the extension never re-validates the budget's own honesty `superRefine`
 * on import (spec §6.3 only mandates re-running `PrefilledFormsSchema` over
 * `payload.forms`), but the type must still be structurally correct so the
 * popup can render budget line items/gaps truthfully.
 *
 * WS-G / G4 — ApplicationBudget (the deterministic, grounded line-item federal
 * budget + justification package built from a user's `CompanyProfile`,
 * optionally sharpened by G1's `ApplicationRequirements.budget_rules` and the
 * `Opportunity.award_range` cross-check).
 *
 * THE HONESTY CONTRACT (R7.7 — mirrors G1's `applicationRequirements.ts` and
 * G2's `applicationDraft.ts`): `capital_requirement` on the profile is a
 * COARSE RANGE BUCKET (e.g. "250k_1m"), never an exact figure. An exact
 * line-item dollar amount is therefore NOT DERIVABLE from the profile and MUST
 * be a `[you to provide: …]` gap — NEVER an invented number. This contract
 * enforces that structurally: every `amount` field (on a line item AND on the
 * total) is REGEX-CONSTRAINED to `FOUNDER_TODO_PATTERN`, so there is no shape
 * of `ApplicationBudget` that carries a synthesized dollar figure. The builder
 * (`lib/apply/budget.ts`) is a PURE, model-free function — no model call, no
 * chance of a hallucinated number in the first place.
 *
 * `FOUNDER_TODO_PATTERN` is reused verbatim from the sibling
 * `applicationDraft.ts` (not redefined) so every WS-G surface — G2's narrative
 * drafts and this budget — shares exactly ONE gap-placeholder convention for
 * G5 to scan.
 */
export { FOUNDER_TODO_PATTERN } from "./applicationDraft";

/**
 * The standard federal (SF-424A-style) direct/indirect cost categories this
 * builder recognizes. Deliberately a closed enum — every line item the
 * builder emits is one of these, so a consumer can render a fixed, ordered
 * budget table.
 */
export const BudgetCategorySchema = z.enum([
  "personnel_salaries",
  "fringe_benefits",
  "travel",
  "equipment",
  "supplies_materials",
  "contractual_subawards",
  "other_direct_costs",
  "indirect_fna",
]);
export type BudgetCategory = z.infer<typeof BudgetCategorySchema>;

/** User-facing label for each category, in standard SF-424A presentation order. */
export const BUDGET_CATEGORY_LABELS: Record<BudgetCategory, string> = {
  personnel_salaries: "Personnel & Salaries",
  fringe_benefits: "Fringe Benefits",
  travel: "Travel",
  equipment: "Equipment",
  supplies_materials: "Supplies & Materials",
  contractual_subawards: "Contractual / Subawards",
  other_direct_costs: "Other Direct Costs",
  indirect_fna: "Indirect Costs / F&A",
};

/** The presentation order every `line_items` array is emitted in. */
export const BUDGET_CATEGORY_ORDER: readonly BudgetCategory[] = [
  "personnel_salaries",
  "fringe_benefits",
  "travel",
  "equipment",
  "supplies_materials",
  "contractual_subawards",
  "other_direct_costs",
  "indirect_fna",
];

/**
 * Where a line item's `justification` prose is grounded. Mirrors G2's
 * `DraftClaim.profile_field` idea, but at the coarser grain this builder
 * operates at:
 *   - `use_of_funds` — paraphrases/quotes the user's `use_of_funds` text
 *     (`source_quote` is a verbatim substring of that field's value).
 *   - `budget_rule`  — grounded in a G1 `BudgetRule` with `specified: true`
 *     (`source_quote` is that rule's verbatim `source_quote`).
 *   - `template`     — no user text to ground in (use_of_funds absent);
 *     the justification itself is an honest `[you to provide: …]` gap
 *     describing what's missing, and `source_quote` is `""`.
 */
export const BudgetJustificationSourceSchema = z.enum([
  "use_of_funds",
  "budget_rule",
  "template",
]);
export type BudgetJustificationSource = z.infer<typeof BudgetJustificationSourceSchema>;

/**
 * One line item in the budget. `amount` is REGEX-CONSTRAINED to
 * `FOUNDER_TODO_PATTERN` — this builder never has an exact dollar figure to
 * put there (a range bucket is not an exact figure), so the schema makes it
 * structurally impossible to ship a synthesized amount.
 */
export const BudgetLineItemSchema = z.object({
  category: BudgetCategorySchema,
  /** User-facing label, carried from `BUDGET_CATEGORY_LABELS[category]`. */
  label: z.string(),
  /** Grounded justification prose — cites `use_of_funds` text or a `budget_rule`, or is an honest template gap. */
  justification: z.string(),
  justification_source: BudgetJustificationSourceSchema,
  /** Verbatim substring backing `justification` (the user's `use_of_funds` value, or a `BudgetRule.source_quote`); `""` for `template`. */
  source_quote: z.string(),
  /** ALWAYS a `[you to provide: …]` gap — an exact figure is never derivable from a range bucket. */
  amount: z.string().regex(FOUNDER_TODO_PATTERN),
});
export type BudgetLineItem = z.infer<typeof BudgetLineItemSchema>;

/**
 * The SF-424 budget total. `range_statement` is either a grounded sentence
 * citing the user's `capital_requirement` profile field (`range_grounded:
 * true`), or — when that field isn't provided — itself an honest
 * `[you to provide: …]` gap (`range_grounded: false`). `amount` (the exact
 * total) is ALWAYS a gap: a range bucket never yields an exact SF-424 figure.
 */
export const BudgetTotalSchema = z
  .object({
    range_statement: z.string(),
    range_grounded: z.boolean(),
    /** The `CompanyProfile` field `range_statement` is grounded in, when `range_grounded` is true. */
    profile_field: z.literal("capital_requirement").optional(),
    /** ALWAYS a `[you to provide: total budget amount]`-shaped gap. */
    amount: z.string().regex(FOUNDER_TODO_PATTERN),
  })
  .refine(
    (t) => t.range_grounded || FOUNDER_TODO_PATTERN.test(t.range_statement),
    { message: "range_statement must be grounded, or itself a [you to provide: …] gap" },
  );
export type BudgetTotal = z.infer<typeof BudgetTotalSchema>;

/**
 * A program budget rule (cost-share, indirect-cost cap, disallowed cost, …)
 * surfaced from a G1 `BudgetRule` with `specified: true`. `source_quote` is
 * that rule's verbatim quote — carried through unchanged, never paraphrased
 * away from its grounding. `note` is an honest, non-determinative nudge (e.g.
 * "confirm the applicable rate with the program officer") — it NEVER asserts
 * the user satisfies the rule.
 */
export const BudgetConstraintSchema = z.object({
  /** The G1 `BudgetRule.rule` text this constraint carries. */
  rule: z.string(),
  /** Verbatim `BudgetRule.source_quote` — the grounding for `rule`. */
  source_quote: z.string(),
  /** Honest, non-determinative guidance; never an assertion of compliance/eligibility. */
  note: z.string(),
});
export type BudgetConstraint = z.infer<typeof BudgetConstraintSchema>;

/**
 * The full deterministic budget package for one opportunity (or a
 * requirements-less/opportunity-less draft, when those optional inputs are
 * omitted). `gaps` is the flat, deduplicated list of every distinct
 * `[you to provide: …]` placeholder appearing anywhere in the package —
 * G5's single scan surface for this artifact.
 */
export const ApplicationBudgetSchema = z.object({
  opportunity_id: z.string().optional(),
  program_title: z.string().optional(),
  /** ISO-8601 timestamp of when this budget was generated. */
  generated_at: z.string().datetime(),

  line_items: z.array(BudgetLineItemSchema).default([]),
  total: BudgetTotalSchema,
  /** Grounded constraints surfaced from `specified: true` G1 `budget_rules`. */
  constraints: z.array(BudgetConstraintSchema).default([]),
  /** Advisory-only cross-checks (e.g. stated range vs. program award ceiling) — never a determination. */
  advisories: z.array(z.string()).default([]),
  /** Top-level honest notes (e.g. "user has not provided use-of-funds detail"). */
  notes: z.array(z.string()).default([]),
  /** Every distinct `[you to provide: …]` placeholder in this package. */
  gaps: z.array(z.string()).default([]),
});
export type ApplicationBudget = z.infer<typeof ApplicationBudgetSchema>;
