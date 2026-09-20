import { test } from "node:test";
import assert from "node:assert/strict";

import { toCompanyProfile, toScreenableOpportunity } from "../bridge";
import { screen } from "../screen";
import { annotateFreshness } from "../freshness";
import { CompanyProfileSchema } from "../../contracts/companyProfile";
import { EligibilityDeterminationSchema } from "../../contracts/eligibilityDetermination";
import type { StartupProfile, Opportunity } from "../../contracts";

/**
 * ELG-04 — the live-pipeline screening BRIDGE, tested deterministically.
 *
 * Exercises exactly the composition `buildOpportunityMap` performs per match —
 * `toCompanyProfile` + `toScreenableOpportunity` + `screen()` + `annotateFreshness`
 * — with hand-built fixtures. NO LLM / OpenAI / Anthropic / network is touched
 * (the bridge and engine are pure logic). This does NOT call `buildOpportunityMap`
 * itself, which would require the live extractor/embedder.
 */

// --- Fixtures ---------------------------------------------------------------

/** A v1 profile the live extractor would produce: employees known, no gates. */
const startupProfile: StartupProfile = {
  description: "We build AI diagnostics for rural clinics.",
  industry: "healthcare",
  technology: "machine learning",
  location: "Utah",
  employees: 12,
};

const baseOpp = {
  source: "grants.gov" as const,
  kind: "grant" as const,
  agency: "Test Agency",
  description: "A federal funding opportunity.",
};

/** Non-SBIR opp → only the universal (conditional) SAM.gov registration gate. */
const nonSbirOpp: Opportunity = {
  ...baseOpp,
  id: "opp-non-sbir",
  program: "Rural Business Development Grant",
};

/** SBIR opp → adds the universal SBIR/STTR size + ownership (categorical) gates. */
const sbirOpp: Opportunity = {
  ...baseOpp,
  id: "opp-sbir",
  program: "SBIR Phase I — Digital Health",
};

// --- toCompanyProfile -------------------------------------------------------

test("toCompanyProfile maps employees → employee_count as model_inferred", () => {
  const cp = toCompanyProfile(startupProfile);

  // The one screening-relevant fact the v1 profile carries.
  assert.ok(cp.employee_count, "employee_count should be present");
  assert.equal(cp.employee_count?.value, 12);
  assert.equal(
    cp.employee_count?.provenance,
    "model_inferred",
    "employee_count must be model_inferred (extractor-inferred, R8.4-safe)",
  );

  // raw_text carries the user's description (not a gate).
  assert.equal(cp.raw_text.value, startupProfile.description);
});

test("toCompanyProfile leaves every eligibility GATE unset (never fabricated)", () => {
  const cp = toCompanyProfile(startupProfile);
  assert.equal(cp.entity_type, undefined);
  assert.equal(cp.us_owned, undefined);
  assert.equal(cp.sam_registered, undefined);
  assert.equal(cp.uei, undefined);
  assert.equal(cp.certifications, undefined);
  assert.equal(cp.prior_federal_funding, undefined);
  assert.equal(cp.geography_designations, undefined);
});

test("toCompanyProfile omits employee_count when employees is absent", () => {
  const cp = toCompanyProfile({ description: "No headcount stated." });
  assert.equal(cp.employee_count, undefined);
});

test("toCompanyProfile produces a schema-valid CompanyProfile", () => {
  assert.doesNotThrow(() => CompanyProfileSchema.parse(toCompanyProfile(startupProfile)));
});

// --- toScreenableOpportunity ------------------------------------------------

test("toScreenableOpportunity falls back title → program so SBIR detection fires", () => {
  const s = toScreenableOpportunity(sbirOpp);
  assert.equal(s.id, "opp-sbir");
  assert.equal(s.program, "SBIR Phase I — Digital Health");
  assert.equal(s.title, "SBIR Phase I — Digital Health");
});

// --- The wired composition (what buildOpportunityMap runs per match) --------

test("bridge + screen attaches a schema-valid determination (non-SBIR → conditionally_eligible)", () => {
  const cp = toCompanyProfile(startupProfile);
  const determination = screen(cp, toScreenableOpportunity(nonSbirOpp));

  assert.doesNotThrow(() => EligibilityDeterminationSchema.parse(determination));
  assert.equal(determination.opportunity_id, "opp-non-sbir");
  // Only the conditional SAM.gov registration gate applies; unset → a step.
  assert.equal(determination.bucket, "conditionally_eligible");
  assert.ok(determination.required_steps.length > 0, "expected a registration step");

  // annotateFreshness wraps it unchanged (same determination reference).
  const wrapped = annotateFreshness(determination);
  assert.equal(wrapped.determination, determination);
  assert.equal(typeof wrapped.freshness.is_stale, "boolean");
});

test("SBIR opp with an unset ownership gate → unknown, never a guess", () => {
  const cp = toCompanyProfile(startupProfile);
  const determination = screen(cp, toScreenableOpportunity(sbirOpp));

  // us_owned is unset → the categorical ownership gate is undetermined → unknown.
  assert.equal(determination.bucket, "unknown");
  assert.notEqual(determination.bucket, "excluded");
});

test("R8.4 safety: a model_inferred size violation renders unknown, never excluded", () => {
  // Employees far over the 500 SBIR ceiling, but only model_inferred → the
  // engine must NOT exclude (the single worst failure R8/§11 prevents).
  const cp = toCompanyProfile({ ...startupProfile, employees: 9000 });
  const determination = screen(cp, toScreenableOpportunity(sbirOpp));

  assert.notEqual(determination.bucket, "excluded");
  assert.equal(
    determination.failed_rules.length,
    0,
    "no rule may land in failed_rules on a model_inferred-only violation",
  );
});
