import {
  isFieldProvided,
  CAPITAL_REQUIREMENT_RANGES,
  type CompanyProfile,
} from "../contracts/companyProfile";
import type { ApplicationRequirements, BudgetRule } from "../contracts/applicationRequirements";
import type { Opportunity } from "../contracts/opportunity";
import {
  ApplicationBudgetSchema,
  BUDGET_CATEGORY_LABELS,
  BUDGET_CATEGORY_ORDER,
  FOUNDER_TODO_PATTERN,
  scanFounderTodos,
  type ApplicationBudget,
  type BudgetCategory,
  type BudgetConstraint,
  type BudgetLineItem,
} from "../contracts/applicationBudget";

/**
 * WS-G / G4 — deterministic, grounded line-item budget builder.
 *
 * `buildBudget(profile, requirements?, opp?)` turns the founder's
 * `CompanyProfile` (`capital_requirement` + `use_of_funds`), optionally
 * sharpened by G1's `ApplicationRequirements.budget_rules` and the
 * opportunity's `award_range`, into a structured `ApplicationBudget`.
 *
 * THIS IS A PURE, MODEL-FREE FUNCTION — no Anthropic call, no network, no
 * randomness. That is the strongest possible grounding guarantee: there is no
 * generative step in which a plausible-looking dollar figure could be
 * hallucinated. Every fact in the output is either:
 *
 *   (a) GROUNDED — a line item's `justification` quotes the founder's actual
 *       `use_of_funds` value verbatim (`source_quote`), or a `constraint` /
 *       indirect-cost line quotes a G1 `BudgetRule.source_quote` verbatim; or
 *   (b) A GAP — every `amount` (line-item and total) is a
 *       `[founder to provide: …]` placeholder, because `capital_requirement`
 *       is a COARSE RANGE BUCKET (e.g. "250k_1m"), not an exact figure, so an
 *       exact line-item dollar amount is never derivable from it.
 *
 * `ApplicationBudgetSchema` enforces (b) STRUCTURALLY: every `amount` field is
 * regex-constrained to `FOUNDER_TODO_PATTERN`, so there is no code path that
 * could ship a synthesized number even by accident. `buildBudget` validates
 * its own output through `ApplicationBudgetSchema.parse(...)` at the end —
 * the same defense-in-depth pattern as G1's `annotateGrounding` +
 * `ApplicationRequirementsSchema.parse` and G2's `enforceGrounding` +
 * `ApplicationDraftSchema.parse`.
 */

// ---------------------------------------------------------------------------
// Gap-placeholder helpers (the `[founder to provide: …]` machinery)
// ---------------------------------------------------------------------------

/** Wrap a plain hint into the exact `[founder to provide: …]` shape (matches `FOUNDER_TODO_PATTERN`). */
function toPlaceholder(hint: string): string {
  const clean = hint.replace(/[[\]]/g, "").replace(/\s+/g, " ").trim();
  return `[founder to provide: ${clean.length > 0 ? clean : "this detail"}]`;
}

// ---------------------------------------------------------------------------
// use_of_funds → category keyword matching (deterministic, no model call)
// ---------------------------------------------------------------------------

interface CategoryRule {
  category: BudgetCategory;
  /** Tested against the (lowercased) `use_of_funds` text. */
  pattern: RegExp;
  /** Short phrase describing the plausibly-implied activity, used in the justification sentence. */
  activity: string;
}

/**
 * One rule per recognizable activity → standard cost category. `fringe_benefits`
 * and `indirect_fna` are DELIBERATELY absent here: fringe is derived from a
 * `personnel_salaries` match (standard federal-budget pairing, see
 * `buildLineItemsFromUseOfFunds`) and indirect is only ever grounded in a G1
 * `budget_rule` (see `indirectLineItemFromRules`) — neither has a founder
 * use-of-funds keyword of its own to match against.
 */
const CATEGORY_RULES: readonly CategoryRule[] = [
  {
    category: "personnel_salaries",
    pattern:
      /\b(hire|hiring|hires|staff(ing)?|salary|salaries|personnel|headcount|engineer|scientist|technician|team member|employee|founder salary)\b/i,
    activity: "hiring or compensating personnel",
  },
  {
    category: "travel",
    pattern:
      /\b(travel|site visit|site visits|conference|conferences|customer visit|customer visits|field test|field testing|field trial|trade show)\b/i,
    activity: "project-related travel",
  },
  {
    category: "equipment",
    pattern:
      /\b(equipment|machinery|manufacturing line|hardware|instrumentation|instrument|tooling|capital equipment|fabrication)\b/i,
    activity: "purchasing, building, or installing equipment",
  },
  {
    category: "supplies_materials",
    pattern:
      /\b(supplies|materials|reagents|consumables|raw material|raw materials|components|parts)\b/i,
    activity: "supplies and materials",
  },
  {
    category: "contractual_subawards",
    pattern:
      /\b(contractor|contractors|subcontract|subcontractor|subcontractors|consultant|consultants|\bcro\b|third[- ]party|outsource|outsourcing|vendor|vendors|subaward|subawards|manufacturing partner|testing lab|clinical validation|clinical trial|contract manufactur\w*)\b/i,
    activity: "contracted or subawarded services",
  },
  {
    category: "other_direct_costs",
    pattern:
      /\b(regulatory|certification|compliance|\bfda\b|marketing|software licens\w*|patent|intellectual property|\bip\b filing|cloud hosting|hosting|data collection|data storage)\b/i,
    activity: "other direct project costs (e.g. regulatory, compliance, or marketing spend)",
  },
];

/** Quote the founder's `use_of_funds` value verbatim in a grounded justification sentence. */
function useOfFundsJustification(activity: string, label: string, quote: string): string {
  return (
    `The founder's stated use of funds — "${quote}" — indicates ${activity}, ` +
    `so this budget includes a ${label} line item.`
  );
}

/** Build one grounded line item for a category matched (or standard-paired) against `use_of_funds`. */
function useOfFundsLineItem(category: BudgetCategory, justification: string, quote: string): BudgetLineItem {
  const label = BUDGET_CATEGORY_LABELS[category];
  return {
    category,
    label,
    justification,
    justification_source: "use_of_funds",
    source_quote: quote,
    amount: toPlaceholder(`${label} amount`),
  };
}

/**
 * Parse `use_of_funds` text and emit one grounded line item per standard
 * category the text plausibly implies, in the fixed `BUDGET_CATEGORY_ORDER`.
 * `fringe_benefits` is auto-paired with a `personnel_salaries` match — a
 * standard federal-budget linkage, not a new fact — grounded in the SAME
 * verbatim quote as the personnel line.
 */
function buildLineItemsFromUseOfFunds(useOfFunds: string): BudgetLineItem[] {
  const quote = useOfFunds.trim();
  const matched = new Set<BudgetCategory>();
  const items = new Map<BudgetCategory, BudgetLineItem>();

  for (const rule of CATEGORY_RULES) {
    if (!rule.pattern.test(quote)) continue;
    matched.add(rule.category);
    const label = BUDGET_CATEGORY_LABELS[rule.category];
    items.set(
      rule.category,
      useOfFundsLineItem(rule.category, useOfFundsJustification(rule.activity, label, quote), quote),
    );
  }

  if (matched.has("personnel_salaries") && !items.has("fringe_benefits")) {
    const label = BUDGET_CATEGORY_LABELS.fringe_benefits;
    const justification =
      `Standard fringe benefits (payroll taxes, health insurance, retirement contributions) ` +
      `associated with the personnel effort described in the founder's stated use of funds — "${quote}".`;
    items.set("fringe_benefits", useOfFundsLineItem("fringe_benefits", justification, quote));
  }

  return BUDGET_CATEGORY_ORDER.filter((c) => items.has(c)).map((c) => items.get(c)!);
}

/**
 * `use_of_funds` is absent: emit the full standard-category checklist so the
 * founder sees the shape of a federal budget, with NEITHER a dollar figure
 * NOR a specific activity invented — both `amount` and `justification` are
 * honest `[founder to provide: …]` gaps.
 */
function buildTemplateLineItems(): BudgetLineItem[] {
  return BUDGET_CATEGORY_ORDER.map((category) => {
    const label = BUDGET_CATEGORY_LABELS[category];
    const activityGap = toPlaceholder(`how funds will be used for ${label.toLowerCase()}`);
    return {
      category,
      label,
      justification: `${label}: ${activityGap}`,
      justification_source: "template" as const,
      source_quote: "",
      amount: toPlaceholder(`${label} amount`),
    };
  });
}

// ---------------------------------------------------------------------------
// budget_rules → constraints + indirect/F&A line item
// ---------------------------------------------------------------------------

/** Keywords that mark a `specified: true` BudgetRule as a surfaceable constraint (cost-share/match, indirect cap, disallowed cost). */
const CONSTRAINT_KEYWORD_PATTERN =
  /\b(cost[- ]shar\w*|match(ing)?|indirect|f&a|disallow\w*|not allowable|unallowable|cap(ped)?|ceiling)\b/i;

/** Narrower: marks a rule as specifically about indirect/F&A cost rate/cap. */
const INDIRECT_KEYWORD_PATTERN = /\b(indirect|f&a)\b/i;

/** Surface every `specified: true` budget_rule matching `CONSTRAINT_KEYWORD_PATTERN` as a grounded, non-determinative constraint. */
function buildConstraints(budgetRules: BudgetRule[] | undefined): BudgetConstraint[] {
  if (!budgetRules) return [];
  return budgetRules
    .filter((r) => r.specified && CONSTRAINT_KEYWORD_PATTERN.test(r.rule))
    .map((r) => ({
      rule: r.rule,
      source_quote: r.source_quote,
      note:
        "This program states a budget rule that may apply to this application. Confirm the exact " +
        "terms (rate, cap, or match requirement) with the program officer or the official solicitation " +
        "before finalizing the budget — this tool does not determine whether the requirement is met.",
    }));
}

/** When a `specified: true` budget_rule is about indirect/F&A, emit a grounded Indirect/F&A line item (amount still a gap). */
function indirectLineItemFromRules(budgetRules: BudgetRule[] | undefined): BudgetLineItem | undefined {
  const rule = (budgetRules ?? []).find((r) => r.specified && INDIRECT_KEYWORD_PATTERN.test(r.rule));
  if (!rule) return undefined;
  const label = BUDGET_CATEGORY_LABELS.indirect_fna;
  return {
    category: "indirect_fna",
    label,
    justification:
      `The program's stated budget rule — "${rule.source_quote}" — addresses indirect/F&A costs. ` +
      `Confirm the applicable rate or cap with the program officer before finalizing this line.`,
    justification_source: "budget_rule",
    source_quote: rule.source_quote,
    amount: toPlaceholder(`${label} amount`),
  };
}

// ---------------------------------------------------------------------------
// capital_requirement → grounded total range
// ---------------------------------------------------------------------------

/** Numeric bounds per `CAPITAL_REQUIREMENT_RANGES` bucket value, for the award-ceiling advisory cross-check only (never used to derive an amount). */
const CAPITAL_REQUIREMENT_BOUNDS: Readonly<Record<string, { floor: number; ceiling?: number }>> = {
  under_250k: { floor: 0, ceiling: 250_000 },
  "250k_1m": { floor: 250_000, ceiling: 1_000_000 },
  "1m_5m": { floor: 1_000_000, ceiling: 5_000_000 },
  over_5m: { floor: 5_000_000 }, // open-ended
};

function capitalRequirementLabel(bucketValue: string): string | undefined {
  return CAPITAL_REQUIREMENT_RANGES.find((r) => r.value === bucketValue)?.label;
}

function formatUsd(amount: number, currency: string): string {
  if (currency === "USD") {
    return amount.toLocaleString("en-US", {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: 0,
    });
  }
  return `${amount.toLocaleString("en-US")} ${currency}`;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Build a deterministic, grounded line-item federal budget + justification
 * from a founder's `CompanyProfile`, optionally sharpened by G1's
 * `ApplicationRequirements` (`budget_rules`) and the opportunity's
 * `award_range`. Pure, model-free — see the module doc for the honesty
 * contract this enforces.
 */
export function buildBudget(
  profile: CompanyProfile,
  requirements?: ApplicationRequirements,
  opp?: Opportunity,
): ApplicationBudget {
  const gapSet = new Set<string>();
  const addGap = (placeholder: string) => {
    if (FOUNDER_TODO_PATTERN.test(placeholder)) gapSet.add(placeholder);
  };

  // --- Line items -----------------------------------------------------------
  const useOfFundsProvided = isFieldProvided(profile, "use_of_funds");
  const useOfFundsValue = profile.use_of_funds?.value ?? "";

  const lineItems: BudgetLineItem[] = useOfFundsProvided
    ? buildLineItemsFromUseOfFunds(useOfFundsValue)
    : buildTemplateLineItems();

  // Indirect/F&A is only ever added when a G1 budget_rule grounds it — never
  // inferred from use_of_funds prose (founders don't narrate overhead) and
  // never included in the use_of_funds-grounded pass above.
  const indirectItem = indirectLineItemFromRules(requirements?.budget_rules);
  if (indirectItem && !lineItems.some((li) => li.category === "indirect_fna")) {
    lineItems.push(indirectItem);
  }

  for (const li of lineItems) {
    addGap(li.amount);
    // FINDING 2: a line item's `justification` can itself embed inline
    // `[founder to provide: …]` placeholders — the use_of_funds-absent template
    // path (`buildTemplateLineItems`) writes one per category, genuinely
    // rendered on the budget. Scan it with the SAME shared scanner
    // `collectAllGaps` runs on narrative draft_text, so every visibly-rendered
    // marker lands in `gaps` (the documented "every distinct placeholder
    // appearing anywhere in the package" surface), not just the amount gap.
    // `addGap` re-validates the shape and `gapSet` dedupes.
    for (const ph of scanFounderTodos(li.justification)) addGap(ph);
  }

  // --- Total ------------------------------------------------------------------
  const capitalRequirementProvided = isFieldProvided(profile, "capital_requirement");
  const capitalRequirementValue = profile.capital_requirement?.value ?? "";
  const rangeLabel = capitalRequirementProvided ? capitalRequirementLabel(capitalRequirementValue) : undefined;

  const totalAmountPlaceholder = toPlaceholder("total budget amount");
  addGap(totalAmountPlaceholder);

  const total = rangeLabel
    ? {
        range_statement: `Founder-stated capital requirement range: ${rangeLabel} (source: profile field "capital_requirement").`,
        range_grounded: true as const,
        profile_field: "capital_requirement" as const,
        amount: totalAmountPlaceholder,
      }
    : (() => {
        const gap = toPlaceholder("capital requirement range");
        addGap(gap);
        return {
          range_statement: gap,
          range_grounded: false as const,
          amount: totalAmountPlaceholder,
        };
      })();

  // --- Constraints (from G1 budget_rules) --------------------------------------
  const constraints = buildConstraints(requirements?.budget_rules);

  // --- Advisories (award-ceiling cross-check — advisory only, never a determination) --
  const advisories: string[] = [];
  if (opp?.award_range?.ceiling != null && capitalRequirementProvided) {
    const bounds = CAPITAL_REQUIREMENT_BOUNDS[capitalRequirementValue];
    if (bounds) {
      const topOfRange = bounds.ceiling ?? Number.POSITIVE_INFINITY;
      if (topOfRange > opp.award_range.ceiling) {
        const ceilingText = formatUsd(opp.award_range.ceiling, opp.award_range.currency ?? "USD");
        const rangeText = rangeLabel ?? capitalRequirementValue;
        advisories.push(
          `Advisory: the founder's stated capital requirement range (${rangeText}) may exceed this ` +
            `program's stated award ceiling (${ceilingText}) — verify against the program's funding ` +
            `limits before finalizing the budget.`,
        );
      }
    }
  }

  // --- Notes --------------------------------------------------------------------
  const notes: string[] = [];
  if (!useOfFundsProvided) {
    notes.push(
      "The founder has not yet provided use-of-funds detail. The line items above are the standard " +
        "federal budget category checklist, not a spending plan — replace each justification and amount " +
        "gap with the founder's actual planned use of funds before submission.",
    );
  }

  const draft: ApplicationBudget = {
    opportunity_id: requirements?.opportunity_id ?? opp?.source_id ?? opp?.id,
    program_title: requirements?.program_title ?? opp?.title ?? opp?.program,
    generated_at: new Date().toISOString(),
    line_items: lineItems,
    total,
    constraints,
    advisories,
    notes,
    gaps: Array.from(gapSet),
  };

  return ApplicationBudgetSchema.parse(draft);
}
