import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ApplicationBudgetSchema,
  FOUNDER_TODO_PATTERN,
  type ApplicationBudget,
} from "../../contracts/applicationBudget";
import type { CompanyProfile } from "../../contracts/companyProfile";
import type { ApplicationRequirements } from "../../contracts/applicationRequirements";
import type { Opportunity } from "../../contracts/opportunity";
import { buildBudget } from "../budget";

/**
 * G4 tests — hermetic, NO network, NO model call. `buildBudget` is a pure,
 * model-free function, so every case exercises real code paths directly
 * against static fixtures.
 */

const NOW_ISO = new Date().toISOString();

/** A `user_stated` provenanced cell. */
function cell<T>(value: T) {
  return { value, provenance: "user_stated" as const, confidence: 1 };
}

/** A profile with both `use_of_funds` and `capital_requirement` provided. */
function fundedProfile(): CompanyProfile {
  return {
    id: "p1",
    raw_text: cell("We build lab-grown diagnostic sensors for rural clinics."),
    industry: cell("medical diagnostics"),
    technology: cell("electrochemical biosensor arrays"),
    location: cell("Boise, Idaho"),
    capital_requirement: cell("250k_1m"),
    use_of_funds: cell("clinical validation and a first manufacturing line"),
    interview_answers: [],
  } as CompanyProfile;
}

/** A profile that has NOT provided `use_of_funds` or `capital_requirement`. */
function bareProfile(): CompanyProfile {
  return {
    id: "p2",
    raw_text: cell("An early-stage hardware startup."),
    interview_answers: [],
  } as CompanyProfile;
}

function requirementsWithBudgetRules(rules: ApplicationRequirements["budget_rules"]): ApplicationRequirements {
  return {
    opportunity_id: "grants-1",
    program_title: "Test Program",
    source_label: "grants.gov",
    extracted_at: NOW_ISO,
    narrative_sections: [],
    forms: [],
    format_limits: [],
    budget_rules: rules,
    attachments: [],
    key_dates: [],
    eligibility_notes: [],
  };
}

function opportunityWithCeiling(ceiling: number): Opportunity {
  return {
    id: "opp_1",
    source: "grants.gov",
    kind: "grant",
    program: "Test Program",
    agency: "HHS",
    description: "An example NOFO.",
    award_range: { floor: 50_000, ceiling, currency: "USD" },
  };
}

// --- Case 1: grounded line items, all amounts are gaps ----------------------

test("a profile with use_of_funds + capital_requirement yields line items grounded in the use_of_funds text, with every amount a [you to provide: …] gap", () => {
  const profile = fundedProfile();
  const budget = buildBudget(profile);

  assert.ok(budget.line_items.length > 0, "expected at least one line item");
  for (const item of budget.line_items) {
    assert.match(item.amount, FOUNDER_TODO_PATTERN, `amount for ${item.category} must be a you-to-provide gap`);
  }

  // At least one line item's justification quotes the user's actual use_of_funds text.
  const quoted = budget.line_items.some((i) =>
    i.justification.includes("clinical validation and a first manufacturing line"),
  );
  assert.ok(quoted, "expected at least one justification to quote the use_of_funds text");

  // The contractual/subawards category should be implied by "clinical validation".
  const contractual = budget.line_items.find((i) => i.category === "contractual_subawards");
  assert.ok(contractual, "expected a contractual/subawards line item");
  assert.equal(contractual!.justification_source, "use_of_funds");
  assert.equal(contractual!.source_quote, "clinical validation and a first manufacturing line");

  // The equipment category should be implied by "manufacturing line".
  const equipment = budget.line_items.find((i) => i.category === "equipment");
  assert.ok(equipment, "expected an equipment line item");

  // Total range is grounded in the user's capital_requirement bucket.
  assert.equal(budget.total.range_grounded, true);
  assert.equal(budget.total.profile_field, "capital_requirement");
  assert.match(budget.total.range_statement, /\$250K.*\$1M/);
  assert.match(budget.total.amount, FOUNDER_TODO_PATTERN);
});

test("use_of_funds absent → minimal standard-category template, every category present, all gaps", () => {
  const profile = bareProfile();
  const budget = buildBudget(profile);

  assert.equal(budget.line_items.length, 8, "expected all 8 standard categories in template mode");
  for (const item of budget.line_items) {
    assert.equal(item.justification_source, "template");
    assert.match(item.amount, FOUNDER_TODO_PATTERN);
    // The justification itself carries an inline gap placeholder (no invented
    // activity) — non-anchored, since the placeholder sits inside a "Category: …" sentence.
    assert.match(
      item.justification,
      /\[you to provide: [^\]]+\]/,
      "template justification must itself carry an honest gap, not an invented activity",
    );
  }

  // Total range is NOT grounded (capital_requirement absent) — itself an honest gap.
  assert.equal(budget.total.range_grounded, false);
  assert.match(budget.total.range_statement, FOUNDER_TODO_PATTERN);

  // A top-level note flags the missing use-of-funds detail.
  assert.ok(budget.notes.some((n) => /use-of-funds/i.test(n)));
});

// --- Case 2: NO invented dollar figure ever appears --------------------------

test("NO invented dollar figure ever appears — every amount is a gap placeholder, never a synthesized number", () => {
  const budget = buildBudget(fundedProfile());

  const allAmounts = [...budget.line_items.map((i) => i.amount), budget.total.amount];
  for (const amount of allAmounts) {
    // Every amount matches the gap shape exactly — a real dollar figure
    // (e.g. "$50,000") could never satisfy this regex.
    assert.match(amount, FOUNDER_TODO_PATTERN);
    // Defense in depth: no amount contains a currency-looking digit sequence.
    assert.doesNotMatch(amount, /\$\s*[\d,]/);
  }

  // The schema itself refuses a synthesized figure — proof the guarantee is
  // structural, not just a convention this test happens to check.
  const tampered: unknown = {
    ...budget,
    line_items: budget.line_items.map((i, idx) => (idx === 0 ? { ...i, amount: "$50,000" } : i)),
  };
  assert.equal(ApplicationBudgetSchema.safeParse(tampered).success, false);
});

// --- Case 3: budget_rules → constraints (specified only) --------------------

test("a specified:true budget_rule surfaces as a grounded constraint carrying its source_quote; a specified:false rule is ignored", () => {
  const profile = fundedProfile();
  const requirements = requirementsWithBudgetRules([
    {
      rule: "Applicants must provide a 20% cost share of the total project cost.",
      source_quote: "Applicants must provide a 20% cost share of the total project cost.",
      specified: true,
    },
    {
      rule: "[not specified in the announcement]",
      source_quote: "",
      specified: false,
    },
  ]);

  const budget = buildBudget(profile, requirements);

  assert.equal(budget.constraints.length, 1);
  assert.equal(
    budget.constraints[0].source_quote,
    "Applicants must provide a 20% cost share of the total project cost.",
  );
  assert.match(budget.constraints[0].rule, /cost share/i);
  // Honest, non-determinative — never asserts the user satisfies the rule.
  assert.doesNotMatch(budget.constraints[0].note, /you (are|qualify|will)/i);
});

test("a specified:true budget_rule about the indirect cost rate also grounds an Indirect/F&A line item", () => {
  const profile = fundedProfile();
  const requirements = requirementsWithBudgetRules([
    {
      rule: "Indirect costs are capped at 10% of total direct costs.",
      source_quote: "Indirect costs are capped at 10% of total direct costs.",
      specified: true,
    },
  ]);

  const budget = buildBudget(profile, requirements);
  const indirect = budget.line_items.find((i) => i.category === "indirect_fna");
  assert.ok(indirect, "expected an Indirect/F&A line item grounded in the budget_rule");
  assert.equal(indirect!.justification_source, "budget_rule");
  assert.equal(indirect!.source_quote, "Indirect costs are capped at 10% of total direct costs.");
  assert.match(indirect!.amount, FOUNDER_TODO_PATTERN);
});

test("award_range.ceiling cross-check adds an honest advisory when the stated range may exceed it", () => {
  const profile = fundedProfile(); // capital_requirement bucket "250k_1m" → up to $1M
  const opp = opportunityWithCeiling(500_000); // ceiling below the top of the bucket
  const budget = buildBudget(profile, undefined, opp);

  assert.ok(budget.advisories.length > 0);
  assert.match(budget.advisories[0], /may exceed/i);
  // Advisory-only phrasing — never a determination.
  assert.doesNotMatch(budget.advisories[0], /will exceed|does exceed|is not eligible/i);
});

// --- Case 4: schema parse accept / reject ------------------------------------

test("ApplicationBudgetSchema.parse accepts a real buildBudget(...) output", () => {
  const budget = buildBudget(fundedProfile());
  assert.doesNotThrow(() => ApplicationBudgetSchema.parse(budget));
});

test("ApplicationBudgetSchema rejects a malformed gap placeholder", () => {
  const budget: ApplicationBudget = buildBudget(fundedProfile());
  const bad = {
    ...budget,
    line_items: budget.line_items.map((item, idx) =>
      idx === 0 ? { ...item, amount: "TODO: fill in personnel amount" } : item,
    ),
  };
  assert.equal(ApplicationBudgetSchema.safeParse(bad).success, false);
});

test("ApplicationBudgetSchema rejects a total.range_statement that is neither grounded nor a valid gap", () => {
  const budget = buildBudget(bareProfile());
  const bad = { ...budget, total: { ...budget.total, range_grounded: false, range_statement: "somewhere between $250K and $1M" } };
  assert.equal(ApplicationBudgetSchema.safeParse(bad).success, false);
});

test("every distinct [you to provide: …] placeholder is present in the top-level gaps list", () => {
  const budget = buildBudget(fundedProfile());
  for (const item of budget.line_items) {
    assert.ok(budget.gaps.includes(item.amount), `expected gaps to include ${item.amount}`);
  }
  assert.ok(budget.gaps.includes(budget.total.amount));
});
