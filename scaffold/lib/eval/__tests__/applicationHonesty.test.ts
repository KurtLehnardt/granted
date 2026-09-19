import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  APPLICATION_GOLDEN_CASES,
  SPARSE_CASE,
  NO_TRACTION_CASE,
  RICH_CASE,
  BANNED_PHRASE_ATTEMPT_CASE,
  type ApplicationGoldenCase,
} from "../applicationGolden";

// The REAL, unmodified apply engine (READ-ONLY import — nothing here is a
// reimplementation or a parallel/looser copy of the anti-fabrication logic).
import { enforceGrounding, validateDraftGrounding, DraftGroundingError } from "../../apply/draft";
import { prefillApplicationForms } from "../../apply/forms";
import { buildBudget } from "../../apply/budget";
import {
  assemblePackage,
  collectAllGaps,
  scanFounderTodos,
  allRegistrationsSatisfied,
  AOR_HANDOFF,
  PACKAGE_INTRO,
  type AssembledPackage,
} from "../../apply/package";
import { ApplicationDraftSchema, FOUNDER_TODO_PATTERN, type ApplicationDraft } from "../../contracts/applicationDraft";
import { isFieldProvided, type CompanyProfile } from "../../contracts/companyProfile";
// Reuse the SAME check:prompts machinery — not a parallel/looser linter.
import { findBannedPhrases } from "../../../scripts/banned-phrases.mjs";

/**
 * G7 — application-eval: proves the WS-G draft/package pipeline NEVER
 * fabricates a founder fact, NEVER claims submission/award, and ALWAYS
 * surfaces `[founder to provide]` gaps for what it does not know.
 *
 * Hermetic — NO network, NO live model call. The golden cases in
 * `../applicationGolden` stand in for the raw G2 model output (the shape
 * `draftOneSection`/`normalizeRawSection` in `lib/apply/draft.ts` hand to
 * grounding enforcement); this suite runs that raw output through the REAL
 * `enforceGrounding` / `validateDraftGrounding` / `ApplicationDraftSchema`,
 * and the REAL `prefillApplicationForms` / `buildBudget` / `assemblePackage`
 * — the deterministic assembly path the apply engine actually runs in
 * production, model call aside.
 *
 * Two real findings in the apply engine surfaced while building this eval were
 * fixed in PR fix/apply-grounding-gaps (draft.ts undeclared-sentence guard +
 * budget.ts justification gap-collection). The two `FIXED (Finding …)` tests
 * below are now real REGRESSION GUARDS asserting the corrected behavior — see
 * that PR (finding G7) for the full writeup.
 */

// ---------------------------------------------------------------------------
// Helpers — wire one golden case through the real pipeline
// ---------------------------------------------------------------------------

/** The golden case's `rawSections` as the PRE-enforcement `ApplicationDraft` (exactly what `enforceGrounding` receives in production). */
function preEnforcementDraft(goldenCase: ApplicationGoldenCase): ApplicationDraft {
  return {
    opportunity_id: goldenCase.opportunity.id,
    program_title: goldenCase.opportunity.title ?? goldenCase.opportunity.program,
    generated_at: new Date().toISOString(),
    sections: goldenCase.rawSections.map((s) => ({
      key: s.key,
      title: s.title,
      prompt: s.prompt,
      draft_text: s.draft_text,
      claims: s.claims,
      gaps: s.gaps,
    })),
  };
}

/** The REAL post-enforcement draft (mirrors what `draftApplication` returns after `enforceGrounding` + schema parse). */
function enforcedDraft(goldenCase: ApplicationGoldenCase): ApplicationDraft {
  const enforced = enforceGrounding(preEnforcementDraft(goldenCase), goldenCase.profile);
  return ApplicationDraftSchema.parse(enforced);
}

/** The full REAL `AssembledPackage` for one golden case, built from its enforced draft. */
function assembleGoldenPackage(goldenCase: ApplicationGoldenCase): AssembledPackage {
  const draft = enforcedDraft(goldenCase);
  const forms = prefillApplicationForms(goldenCase.profile, goldenCase.reqs, goldenCase.opportunity);
  const budget = buildBudget(goldenCase.profile, undefined, goldenCase.opportunity);
  return assemblePackage({
    opportunity_id: goldenCase.opportunity.id,
    program_title: goldenCase.opportunity.title ?? goldenCase.opportunity.program,
    forms,
    budget,
    checklist: { allRegistrationsSatisfied: allRegistrationsSatisfied(goldenCase.reqs) },
    narrativeSections: goldenCase.narrativeSections,
    draft,
    narrativeStatus: "drafted",
    requirementsAvailable: true,
  });
}

/** Every human-visible string in an assembled package, concatenated for a submission/award-claim sweep. */
function allVisibleText(pkg: AssembledPackage): string {
  const narrative = pkg.narratives.map((s) => s.draft_text).join(" ");
  const formsText = pkg.forms.forms.flatMap((f) => f.fields.map((field) => field.display)).join(" ");
  const budgetText = [
    ...pkg.budget.line_items.map((li) => li.justification),
    ...pkg.budget.notes,
    ...pkg.budget.advisories,
    pkg.budget.total.range_statement,
    ...pkg.budget.constraints.map((c) => c.note),
  ].join(" ");
  return [narrative, formsText, budgetText].join(" ");
}

/**
 * Positive submission/award/eligibility CONFIRMATIONS the package must never
 * state, anywhere. Regex/set-based (not brittle exact-string matches), and
 * deliberately crafted NOT to match the honest AOR hand-off's own negations
 * ("nothing was submitted", "no application was filed").
 */
const SUBMIT_CONFIRMATION_PATTERNS: readonly RegExp[] = [
  /application (has been |was )?submitted\b/i,
  /we (have |)submitted/i,
  /automatically submit/i,
  /you('ve| have) won\b/i,
  /application (was |has been )?approved\b/i,
  // Negative lookbehind excludes the honest negation "no application was
  // filed" (AOR_HANDOFF.body) while still catching a bare positive claim.
  /(?<!no )application (was |has been )?filed\b/i,
  // Word-boundary on BOTH sides — an unanchored `awarded\b` would false-positive
  // inside "subawarded" (a real budget-category term: "contracted or
  // subawarded services", see budget.ts CATEGORY_RULES).
  /\bawarded\b/i,
  /you (are|'re) eligible/i,
  /you qualify/i,
  /this application (is|has been) (funded|awarded)\b/i,
];

// ---------------------------------------------------------------------------
// Invariant 1 — every factual claim traces to a provided field, or becomes a
// [founder to provide: …] gap. No invented metrics/traction/eligibility.
// ---------------------------------------------------------------------------

describe("invariant 1: no fabrication — every claim is grounded or neutralized to a gap", () => {
  for (const goldenCase of APPLICATION_GOLDEN_CASES) {
    test(`${goldenCase.id}: raw candidate honesty holds after the real enforceGrounding pass`, () => {
      const raw = preEnforcementDraft(goldenCase);
      const preCheck = validateDraftGrounding(raw, goldenCase.profile);

      if (goldenCase.hasDeclaredFabricationRisk) {
        // The fixture is a REAL fabrication risk pre-enforcement (not a strawman):
        // the real validator must independently catch it.
        assert.equal(preCheck.grounded, false, `expected ${goldenCase.id} raw draft to fail grounding pre-enforcement`);
        assert.ok(
          preCheck.issues.some((i) => /fabrication risk|non-provided field/i.test(i)),
          `expected a fabrication-risk issue, got: ${preCheck.issues.join("; ")}`,
        );
      } else {
        // No fabrication attempted in this fixture — it should already be grounded.
        assert.equal(preCheck.grounded, true, `issues: ${preCheck.issues.join("; ")}`);
      }

      // The REAL post-enforcement draft (what actually ships in the package).
      const enforced = enforceGrounding(raw, goldenCase.profile);
      const postCheck = validateDraftGrounding(enforced, goldenCase.profile);
      assert.equal(postCheck.grounded, true, `post-enforcement issues: ${postCheck.issues.join("; ")}`);
      assert.doesNotThrow(() => ApplicationDraftSchema.parse(enforced));

      // Every SURVIVING claim cites a field the profile actually provides —
      // checked directly against the real `isFieldProvided`, not re-derived.
      for (const section of enforced.sections) {
        for (const claim of section.claims) {
          assert.ok(
            isFieldProvided(goldenCase.profile, claim.profile_field),
            `${goldenCase.id}/${section.key}: surviving claim cites non-provided field '${claim.profile_field}'`,
          );
        }
      }
    });
  }

  test("sparse-founder: the declared fabricated revenue figure is scrubbed and replaced with an honest gap", () => {
    const enforced = enforcedDraft(SPARSE_CASE);
    const traction = enforced.sections.find((s) => s.key === "traction_and_impact")!;
    assert.doesNotMatch(traction.draft_text, /\$180,000/);
    assert.match(traction.draft_text, /\[founder to provide: [^\]]*revenue[^\]]*\]/i);
  });

  test("no-traction: the declared fabricated $95,000 revenue figure is scrubbed and replaced with an honest gap", () => {
    const enforced = enforcedDraft(NO_TRACTION_CASE);
    const commercialization = enforced.sections.find((s) => s.key === "commercialization_plan")!;
    assert.doesNotMatch(commercialization.draft_text, /\$95,000/);
    assert.match(commercialization.draft_text, /\[founder to provide: [^\]]*revenue[^\]]*\]/i);
  });

  test("rich-founder: revenue/technology/traction claims are genuinely grounded — nothing is neutralized", () => {
    const raw = preEnforcementDraft(RICH_CASE);
    const enforced = enforceGrounding(raw, RICH_CASE.profile);
    // Every claim from the raw candidate survives verbatim (nothing needed neutralizing).
    const rawClaimCount = raw.sections.reduce((n, s) => n + s.claims.length, 0);
    const enforcedClaimCount = enforced.sections.reduce((n, s) => n + s.claims.length, 0);
    assert.equal(enforcedClaimCount, rawClaimCount);
    // And the rich profile's own real numbers appear in the shipped draft.
    const allText = enforced.sections.map((s) => s.draft_text).join(" ");
    assert.match(allText, /under \$100K/i);
  });

  // ---------------------------------------------------------------------------
  // FIXED — Finding 1 (lib/apply/draft.ts), PR fix/apply-grounding-gaps.
  // `enforceGrounding` used to inspect only the model's DECLARED `claims` array,
  // so a factual-sounding sentence written directly into `draft_text` with NO
  // corresponding `claims` entry (and no gap) bypassed grounding entirely —
  // shipping an invented specific with no `[founder to provide: …]` marker at
  // all. The undeclared-sentence guard now makes the check account for the
  // ENTIRE `draft_text`: a sentence carrying a HIGH-SIGNAL specific-quantitative
  // token ($-amounts, N% percentages, comma-grouped counts like 3,000) whose
  // number is NOT accounted for by a declared grounded claim is WRAPPED IN PLACE
  // into a `[founder to provide: verify or remove …]` gap. It can no longer read
  // as an asserted fact and now surfaces in every gap-summary surface. (Scope is
  // deliberately narrow — bare integers, reference cites, and purely qualitative
  // claims are NOT wrapped; see the `Finding-1 guard` robustness suite above.)
  // This test is now a real REGRESSION GUARD on the fix.
  // ---------------------------------------------------------------------------
  test("FIXED (Finding 1): an UNDECLARED factual sentence (no claims entry) is wrapped into a founder-to-provide marker, never shipped as a bare assertion", () => {
    const enforced = enforcedDraft(SPARSE_CASE);
    const traction = enforced.sections.find((s) => s.key === "traction_and_impact")!;

    // With every [founder to provide: …] marker stripped out, the invented
    // "3,000 rural clinics" metric is gone from the bare narrative prose — it no
    // longer ships as an asserted fact.
    const withoutMarkers = traction.draft_text.replace(/\[founder to provide: [^\]]+\]/g, "");
    assert.doesNotMatch(withoutMarkers, /Our platform now serves more than 3,000/);
    assert.doesNotMatch(withoutMarkers, /3,000/);

    // Instead the whole sentence is WRAPPED inside a founder-to-provide
    // verify-or-remove marker (flagged for the founder, not silently deleted).
    assert.match(
      traction.draft_text,
      /\[founder to provide: [^\]]*Our platform now serves more than 3,000 rural clinics nationwide[^\]]*\]/,
    );

    // That marker is a real, well-formed gap the pipeline surfaces end-to-end:
    // the section still validates as grounded, the schema still parses, and the
    // marker appears in the assembled package's single gap-summary surface.
    const check = validateDraftGrounding(enforced, SPARSE_CASE.profile);
    assert.equal(check.grounded, true, `post-fix issues: ${check.issues.join("; ")}`);
    assert.doesNotThrow(() => ApplicationDraftSchema.parse(enforced));

    const pkg = assembleGoldenPackage(SPARSE_CASE);
    assert.ok(
      pkg.gaps.some((g) => /Our platform now serves more than 3,000 rural clinics nationwide/.test(g)),
      "expected the wrapped undeclared statement to surface in pkg.gaps",
    );

    // The purely non-factual framing sentence is deliberately left intact.
    assert.match(traction.draft_text, /This project will expand our reach to underserved communities\./);
  });
});

// ---------------------------------------------------------------------------
// Finding-1 guard robustness — the guard runs on EVERY production draft, so it
// must not over-wrap benign/reference numbers, must not fragment sentences at
// abbreviations, must preserve whitespace/paragraphs when nothing is wrapped,
// and must tolerate a grounded number's paraphrase — while STILL wrapping a
// genuinely undeclared specific-quantitative sentence. Each fixture below is
// run through the REAL `enforceGrounding`.
// ---------------------------------------------------------------------------

describe("Finding-1 guard: narrow, in-place, abbreviation-safe", () => {
  const cell = <T,>(value: T) => ({ value, provenance: "user_stated" as const, confidence: 1 });
  const EMPTY_PROFILE: CompanyProfile = {
    id: "guard-empty",
    raw_text: cell(""),
    interview_answers: [],
  };
  const GROUNDED_CLINICS_PROFILE: CompanyProfile = {
    id: "guard-grounded",
    raw_text: cell(""),
    target_customers: cell("rural community health clinics"),
    interview_answers: [],
  };

  /** Run one section's `draft_text` through the real enforceGrounding, return the enforced draft_text. */
  function runGuard(
    draftText: string,
    claims: { text: string; profile_field: string }[],
    profile: CompanyProfile,
  ): string {
    const draft: ApplicationDraft = {
      opportunity_id: "guard-fixture",
      program_title: "Guard Fixture",
      generated_at: new Date().toISOString(),
      sections: [{ key: "s", title: "S", prompt: "p", draft_text: draftText, claims, gaps: [] }],
    };
    return enforceGrounding(draft, profile).sections[0].draft_text;
  }

  const stripMarkers = (text: string) => text.replace(/\[founder to provide: [^\]]+\]/g, "");

  // MUST NOT be wrapped or fragmented — each returns byte-for-byte unchanged.
  const MUST_NOT_WRAP: readonly string[] = [
    "Our software complies with Section 508 accessibility standards.",
    "Over the past 3 years, we have refined our approach to rural care.",
    "We provide 24/7 support to every partner clinic.",
    "We partner with the U.S. Government on 12 pilot sites.",
  ];
  for (const sentence of MUST_NOT_WRAP) {
    test(`does NOT wrap or fragment: ${JSON.stringify(sentence)}`, () => {
      const out = runGuard(sentence, [], EMPTY_PROFILE);
      assert.equal(out, sentence, "benign/reference sentence must pass through unchanged");
      assert.doesNotMatch(out, /\[founder to provide:/);
    });
  }

  test("grounded-number tolerance: a declared '3,000 rural clinics' claim protects the paraphrase 'over 3,000 rural clinics'", () => {
    const sentence = "We serve over 3,000 rural clinics.";
    const out = runGuard(sentence, [{ text: "We serve 3,000 rural clinics", profile_field: "target_customers" }], GROUNDED_CLINICS_PROFILE);
    assert.equal(out, sentence, "a number present in a declared grounded claim must not be re-wrapped");
  });

  test("multi-paragraph draft keeps its \\n\\n paragraph breaks when nothing is wrapped (no flattening)", () => {
    const multi = "First paragraph about our mission and values.\n\nSecond paragraph about our team and vision.";
    const out = runGuard(multi, [], EMPTY_PROFILE);
    assert.equal(out, multi);
    assert.match(out, /\n\n/);
  });

  test("STILL wraps an undeclared $-amount sentence (wrap, don't delete)", () => {
    const sentence = "We closed $2,400,000 in new contracts last year.";
    const out = runGuard(sentence, [], EMPTY_PROFILE);
    // Wrapped into a founder-to-provide marker; the raw figure no longer reads as a bare assertion.
    assert.match(out, /\[founder to provide: [^\]]*\$2,400,000[^\]]*\]/);
    assert.doesNotMatch(stripMarkers(out), /\$2,400,000/);
  });

  test("abbreviation-safe WHILE wrapping: 'U.S.' does not fragment the sentence — the whole sentence is wrapped as one unit", () => {
    const sentence = "We partner with the U.S. Government across 3,000 clinics.";
    const out = runGuard(sentence, [], EMPTY_PROFILE);
    // One marker wrapping the ENTIRE sentence (abbreviation kept inside, not split on).
    assert.match(
      out,
      /\[founder to provide: verify or remove this unverified statement — "We partner with the U\.S\. Government across 3,000 clinics\."\]/,
    );
    // Nothing leaked outside the marker (no fragment like "...the U.S." left bare).
    assert.equal(stripMarkers(out).trim(), "");
  });
});

// ---------------------------------------------------------------------------
// Invariant 2 — never claims submission, award, or eligibility.
// ---------------------------------------------------------------------------

describe("invariant 2: never claims submission/award/eligibility", () => {
  for (const goldenCase of APPLICATION_GOLDEN_CASES) {
    test(`${goldenCase.id}: the fully assembled package contains no submission/award/eligibility confirmation`, () => {
      const pkg = assembleGoldenPackage(goldenCase);
      const text = allVisibleText(pkg);

      assert.deepEqual(findBannedPhrases(text), [], `${goldenCase.id}: banned phrase found in assembled package`);
      for (const re of SUBMIT_CONFIRMATION_PATTERNS) {
        assert.doesNotMatch(text, re, `${goldenCase.id}: assembled package matched forbidden pattern ${re}`);
      }
    });
  }

  test("the hand-authored AOR hand-off + package intro copy also passes the same forbidden-pattern sweep", () => {
    const copy = [AOR_HANDOFF.eyebrow, AOR_HANDOFF.headline, AOR_HANDOFF.body, AOR_HANDOFF.cta, PACKAGE_INTRO.eyebrow, PACKAGE_INTRO.note].join(
      " ",
    );
    assert.deepEqual(findBannedPhrases(copy), []);
    for (const re of SUBMIT_CONFIRMATION_PATTERNS) {
      assert.doesNotMatch(copy, re, `AOR/intro copy matched forbidden pattern ${re}`);
    }
  });

  test("adversarial raw draft asserting eligibility outright is REFUSED (thrown), never shipped", () => {
    const raw = preEnforcementDraft(BANNED_PHRASE_ATTEMPT_CASE);
    assert.throws(() => enforceGrounding(raw, BANNED_PHRASE_ATTEMPT_CASE.profile), DraftGroundingError);
  });
});

// ---------------------------------------------------------------------------
// Invariant 3 — every genuine gap surfaces a [founder to provide] marker.
// ---------------------------------------------------------------------------

describe("invariant 3: every genuine gap surfaces a [founder to provide] marker", () => {
  for (const goldenCase of APPLICATION_GOLDEN_CASES) {
    test(`${goldenCase.id}: pkg.gaps is non-empty, well-formed, and a superset of every inline narrative placeholder`, () => {
      const pkg = assembleGoldenPackage(goldenCase);

      assert.ok(pkg.gaps.length > 0, `${goldenCase.id}: expected at least one founder-to-provide gap`);
      for (const g of pkg.gaps) assert.match(g, FOUNDER_TODO_PATTERN);

      // Every inline placeholder actually printed in a drafted narrative is
      // collected into the package's single gap-summary surface.
      const inlinePlaceholders = pkg.narratives.flatMap((s) => scanFounderTodos(s.draft_text));
      for (const ph of inlinePlaceholders) {
        assert.ok(pkg.gaps.includes(ph), `${goldenCase.id}: inline placeholder ${ph} missing from pkg.gaps`);
      }
      // Every forms gap is collected too.
      for (const g of pkg.forms.gaps) assert.ok(pkg.gaps.includes(g), `${goldenCase.id}: forms gap ${g} missing from pkg.gaps`);
    });
  }

  test("sparse-founder: missing identity fields (technology, location) surface as real gaps", () => {
    const pkg = assembleGoldenPackage(SPARSE_CASE);
    const joined = pkg.gaps.join(" | ");
    assert.match(joined, /core technology/i);
    assert.match(joined, /primary location/i);
  });

  test("collectAllGaps matches assemblePackage's own gaps field (single gap-summary surface, exercised directly)", () => {
    for (const goldenCase of APPLICATION_GOLDEN_CASES) {
      const draft = enforcedDraft(goldenCase);
      const forms = prefillApplicationForms(goldenCase.profile, goldenCase.reqs, goldenCase.opportunity);
      const budget = buildBudget(goldenCase.profile, undefined, goldenCase.opportunity);
      const direct = collectAllGaps({ draft, forms, budget });
      const pkg = assembleGoldenPackage(goldenCase);
      assert.deepEqual(pkg.gaps, direct, `${goldenCase.id}: assemblePackage.gaps diverged from collectAllGaps`);
    }
  });

  // ---------------------------------------------------------------------------
  // FIXED — Finding 2 (lib/apply/budget.ts), PR fix/apply-grounding-gaps.
  // When `use_of_funds` is absent, `buildTemplateLineItems` embeds a
  // `[founder to provide: how funds will be used for <category>]` placeholder
  // INSIDE each line item's `justification` (genuinely rendered on the package).
  // `buildBudget` used to call only `addGap(li.amount)`, so up to 8 of those
  // visibly-rendered markers were silently missing from `budget.gaps` — and
  // therefore from `collectAllGaps`/`AssembledPackage.gaps`, contradicting
  // `applicationBudget.ts`'s own doc: "`gaps` is the flat, deduplicated list of
  // every distinct `[founder to provide: …]` placeholder appearing anywhere in
  // the package." `buildBudget` now also scans each `justification` with the
  // SAME shared `scanFounderTodos` scanner `collectAllGaps` uses on narrative
  // draft_text, adding every match to the gap set. This test is now a real
  // REGRESSION GUARD on the fix.
  // ---------------------------------------------------------------------------
  test("FIXED (Finding 2): template line-item justification placeholders (use_of_funds absent) ARE collected into budget.gaps", () => {
    // SPARSE_CASE's profile has no use_of_funds, so buildBudget falls back to
    // the full standard-category template (see budget.ts buildTemplateLineItems).
    const budget = buildBudget(SPARSE_CASE.profile, undefined, SPARSE_CASE.opportunity);
    const justificationText = budget.line_items.map((li) => li.justification).join(" | ");
    const renderedPlaceholders = scanFounderTodos(justificationText);

    // Fixed behavior: every placeholder embedded in a rendered justification is
    // now present in the budget's own `gaps` array.
    assert.ok(renderedPlaceholders.length > 0, "expected the template path to embed justification placeholders");
    for (const ph of renderedPlaceholders) {
      assert.ok(
        budget.gaps.includes(ph),
        `expected justification placeholder ${ph} to be collected into budget.gaps`,
      );
    }

    // And therefore the ASSEMBLED PACKAGE's single gap-summary surface carries
    // them too — a founder scanning `pkg.gaps` alone now sees every blank that
    // is printed in the budget line items.
    const pkg = assembleGoldenPackage(SPARSE_CASE);
    for (const ph of renderedPlaceholders) {
      assert.ok(pkg.gaps.includes(ph), `expected justification placeholder ${ph} to surface in pkg.gaps`);
    }
  });
});

// ---------------------------------------------------------------------------
// Invariant 4 — a sparse profile yields MORE gaps than a rich profile.
// ---------------------------------------------------------------------------

describe("invariant 4: sparser profiles yield more gaps", () => {
  test("sparse > no-traction > rich, in total package gaps", () => {
    const sparse = assembleGoldenPackage(SPARSE_CASE);
    const noTraction = assembleGoldenPackage(NO_TRACTION_CASE);
    const rich = assembleGoldenPackage(RICH_CASE);

    assert.ok(
      sparse.gaps.length > rich.gaps.length,
      `expected sparse (${sparse.gaps.length}) > rich (${rich.gaps.length})`,
    );
    assert.ok(
      noTraction.gaps.length > rich.gaps.length,
      `expected no-traction (${noTraction.gaps.length}) > rich (${rich.gaps.length})`,
    );
    assert.ok(
      sparse.gaps.length >= noTraction.gaps.length,
      `expected sparse (${sparse.gaps.length}) >= no-traction (${noTraction.gaps.length})`,
    );
  });

  test("the rich profile's registration facts clear the SF-424 UEI/entity/AOR/NAICS gaps the sparse profile leaves open", () => {
    const sparse = assembleGoldenPackage(SPARSE_CASE);
    const rich = assembleGoldenPackage(RICH_CASE);
    const sparseJoined = sparse.gaps.join(" | ").toLowerCase();
    const richJoined = rich.gaps.join(" | ").toLowerCase();

    assert.match(sparseJoined, /unique entity identifier|uei/);
    assert.doesNotMatch(richJoined, /unique entity identifier \(uei\)/);
  });
});

// ---------------------------------------------------------------------------
// Smoke test — the deterministic assembly path runs end-to-end for every
// golden case without throwing (the eval actually EXERCISES the real engine).
// ---------------------------------------------------------------------------

test("smoke: every golden case assembles into a valid, schema-conformant package", () => {
  for (const goldenCase of APPLICATION_GOLDEN_CASES) {
    const pkg = assembleGoldenPackage(goldenCase);
    assert.equal(pkg.narrativeStatus, "drafted");
    assert.equal(pkg.opportunity_id, goldenCase.opportunity.id);
    assert.ok(pkg.forms.forms.length > 0);
    assert.ok(pkg.budget.line_items.length > 0);
  }
});
