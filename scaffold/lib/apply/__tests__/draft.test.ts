import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ApplicationDraftSchema,
  FOUNDER_TODO_PATTERN,
  type ApplicationDraft,
} from "../../contracts/applicationDraft";
import type { CompanyProfile } from "../../contracts/companyProfile";
import {
  validateDraftGrounding,
  enforceGrounding,
  DraftGroundingError,
} from "../draft";
import { loadPrompt } from "../../prompts";
// Reuse the SAME check:prompts machinery — not a parallel linter.
import { findBannedPhrases } from "../../../scripts/check-prompt-registry.mjs";

/**
 * G2 tests — hermetic, NO network, STATIC fixtures only. The model is never
 * called here; every case exercises the schema and the pure grounding logic
 * (`validateDraftGrounding` / `enforceGrounding`), including the reused
 * `findBannedPhrases` guard.
 */

/** A `user_stated` provenanced cell. */
function cell<T>(value: T) {
  return { value, provenance: "user_stated" as const, confidence: 1 };
}

/**
 * A partially-filled profile: `technology` IS provided; `revenue` and
 * `capital_raised` are NOT. This is the anti-fabrication fixture — a draft may
 * ground a claim in `technology`, but a claim citing `revenue` is a fabrication
 * risk and must be caught.
 */
function sampleProfile(): CompanyProfile {
  return {
    id: "p1",
    raw_text: cell("We build lab-grown diagnostic sensors for rural clinics."),
    industry: cell("medical diagnostics"),
    technology: cell("electrochemical biosensor arrays"),
    location: cell("Boise, Idaho"),
    use_of_funds: cell("clinical validation and a first manufacturing line"),
    interview_answers: [],
  } as CompanyProfile;
}

/** A well-formed, fully-grounded single-section draft (used as the accept fixture). */
function baseDraft(overrides: Partial<ApplicationDraft["sections"][number]> = {}): ApplicationDraft {
  return {
    opportunity_id: "grants-1",
    program_title: "Test Program",
    generated_at: new Date().toISOString(),
    sections: [
      {
        key: "project_summary",
        title: "Project Summary",
        prompt: "Summarize your project.",
        draft_text: "We build electrochemical biosensor arrays for rural clinics.",
        claims: [
          {
            text: "We build electrochemical biosensor arrays for rural clinics.",
            profile_field: "technology",
          },
        ],
        gaps: [],
        ...overrides,
      },
    ],
  };
}

// --- Case 1: schema accept / reject ----------------------------------------

test("ApplicationDraftSchema.parse accepts a well-formed package", () => {
  assert.doesNotThrow(() => ApplicationDraftSchema.parse(baseDraft()));
});

test("safeParse rejects a gap whose placeholder violates FOUNDER_TODO_PATTERN", () => {
  const bad = baseDraft({
    draft_text: "We build sensors. [you to provide: annual revenue]",
    gaps: [{ field_hint: "annual revenue", placeholder: "TODO: revenue" }], // malformed shape
  });
  assert.equal(ApplicationDraftSchema.safeParse(bad).success, false);
});

test("FOUNDER_TODO_PATTERN matches the exact placeholder shape and rejects near-misses", () => {
  assert.match("[you to provide: annual revenue]", FOUNDER_TODO_PATTERN);
  assert.doesNotMatch("[you to provide:]", FOUNDER_TODO_PATTERN); // needs content
  assert.doesNotMatch("you to provide: revenue", FOUNDER_TODO_PATTERN); // needs brackets
});

// --- Case 2: anti-fabrication headline -------------------------------------
// A profile missing `revenue` must yield a `[you to provide]`, NEVER a
// made-up number.

test("a claim citing a NON-provided field (revenue) FAILS validateDraftGrounding, naming the field", () => {
  const profile = sampleProfile(); // no revenue, no capital_raised
  const draft = baseDraft({
    draft_text: "We build sensors. Our annual revenue is $4.2M.",
    claims: [
      { text: "We build sensors.", profile_field: "technology" },
      { text: "Our annual revenue is $4.2M.", profile_field: "revenue" }, // fabrication risk
    ],
    gaps: [],
  });
  const { grounded, issues } = validateDraftGrounding(draft, profile);
  assert.equal(grounded, false);
  assert.equal(issues.length, 1);
  assert.match(issues[0], /revenue/);
  assert.match(issues[0], /non-provided field|fabrication risk/i);
});

test("the HONEST counterpart — the same fact as a [you to provide: annual revenue] gap — PASSES", () => {
  const profile = sampleProfile();
  const draft = baseDraft({
    draft_text: "We build sensors. [you to provide: annual revenue]",
    claims: [{ text: "We build sensors.", profile_field: "technology" }],
    gaps: [{ field_hint: "annual revenue", placeholder: "[you to provide: annual revenue]" }],
  });
  const { grounded, issues } = validateDraftGrounding(draft, profile);
  assert.equal(grounded, true, `expected grounded, issues: ${JSON.stringify(issues)}`);
});

test("enforceGrounding NEUTRALIZES a fabricated revenue claim into a [you to provide: annual revenue] gap", () => {
  const profile = sampleProfile();
  const draft = baseDraft({
    draft_text: "We build sensors. Our annual revenue is $4.2M.",
    claims: [
      { text: "We build sensors.", profile_field: "technology" },
      { text: "Our annual revenue is $4.2M.", profile_field: "revenue" },
    ],
    gaps: [],
  });
  const enforced = enforceGrounding(draft, profile);
  const section = enforced.sections[0];

  // The made-up number is gone; the honest placeholder took its place.
  assert.doesNotMatch(section.draft_text, /\$4\.2M/);
  assert.match(section.draft_text, /\[you to provide: annual revenue\]/);
  // The revenue claim is dropped; the grounded technology claim survives.
  assert.deepEqual(
    section.claims.map((c) => c.profile_field),
    ["technology"],
  );
  // A matching gap now exists, with a valid placeholder.
  assert.equal(section.gaps.length, 1);
  assert.equal(section.gaps[0].placeholder, "[you to provide: annual revenue]");
  assert.match(section.gaps[0].placeholder, FOUNDER_TODO_PATTERN);
  // And the neutralized draft now passes both grounding and the schema.
  assert.equal(validateDraftGrounding(enforced, profile).grounded, true);
  assert.doesNotThrow(() => ApplicationDraftSchema.parse(enforced));
});

// --- Case 3: provided-field claim passes; orphans are caught (clause c) -----

test("a claim citing a PROVIDED field (technology) PASSES", () => {
  const { grounded, issues } = validateDraftGrounding(baseDraft(), sampleProfile());
  assert.equal(grounded, true, `issues: ${JSON.stringify(issues)}`);
});

test("an ORPHAN placeholder (in draft_text, no gap) is caught", () => {
  const profile = sampleProfile();
  const draft = baseDraft({
    draft_text: "We build sensors. [you to provide: annual revenue]",
    claims: [{ text: "We build sensors.", profile_field: "technology" }],
    gaps: [], // no gap for the inline placeholder
  });
  const { grounded, issues } = validateDraftGrounding(draft, profile);
  assert.equal(grounded, false);
  assert.ok(issues.some((i) => /orphan placeholder/.test(i)), issues.join("\n"));
});

test("an ORPHAN gap (placeholder absent from draft_text) is caught", () => {
  const profile = sampleProfile();
  const draft = baseDraft({
    draft_text: "We build sensors.",
    claims: [{ text: "We build sensors.", profile_field: "technology" }],
    gaps: [{ field_hint: "annual revenue", placeholder: "[you to provide: annual revenue]" }],
  });
  const { grounded, issues } = validateDraftGrounding(draft, profile);
  assert.equal(grounded, false);
  assert.ok(issues.some((i) => /orphan gap/.test(i)), issues.join("\n"));
});

// --- Case 4: banned-phrasing reuse (the SAME machinery) --------------------

test("findBannedPhrases over the drafting template returns [] (the template is clean)", () => {
  const template = loadPrompt("draftApplicationSection").template;
  assert.deepEqual(findBannedPhrases(template), []);
});

test("clause (d): a draft_text asserting eligibility is caught via findBannedPhrases", () => {
  const profile = sampleProfile();
  const draft = baseDraft({
    draft_text: "We build sensors, so you are eligible for this award.",
    claims: [{ text: "We build sensors.", profile_field: "technology" }],
    gaps: [],
  });
  const { grounded, issues } = validateDraftGrounding(draft, profile);
  assert.equal(grounded, false);
  assert.ok(issues.some((i) => /you are eligible/.test(i)), issues.join("\n"));
});

test("enforceGrounding THROWS on a banned eligibility assertion (no honest placeholder for it)", () => {
  const profile = sampleProfile();
  const draft = baseDraft({
    draft_text: "We build sensors, so you are eligible for this award.",
    claims: [{ text: "We build sensors.", profile_field: "technology" }],
    gaps: [],
  });
  assert.throws(() => enforceGrounding(draft, profile), DraftGroundingError);
});
