import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { FOUNDER_TODO_PATTERN, type ApplicationDraft } from "../../contracts/applicationDraft";
import type { CompanyProfile } from "../../contracts/companyProfile";
import { isFieldProvided } from "../../contracts/companyProfile";
import type { Opportunity } from "../../contracts/opportunity";
import type { StartupProfile } from "../../contracts";
import type { AutoFillRequirements } from "../../mockAuth";
import { EMPTY_AUTO_FILL_REQUIREMENTS } from "../../mockAuth";
import { prefillApplicationForms } from "../forms";
import { buildBudget } from "../budget";
import {
  collectAllGaps,
  assemblePackage,
  scanFounderTodos,
  allRegistrationsSatisfied,
  startupProfileToCompanyProfile,
  AOR_HANDOFF,
  PACKAGE_INTRO,
} from "../package";
// Reuse the SAME check:prompts machinery — not a parallel linter.
import { findBannedPhrases } from "../../../scripts/check-prompt-registry.mjs";

/**
 * G5 tests — hermetic, NO network, STATIC fixtures only. The model is never
 * called. These exercise the pure assembly + gap-collection core and the
 * honest-copy invariants. The G3 forms and G4 budget are built with their REAL
 * model-free builders (they never call a model), giving schema-valid fixtures.
 */

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function cell<T>(value: T) {
  return { value, provenance: "user_stated" as const, confidence: 1 };
}

function sampleProfile(): CompanyProfile {
  return {
    id: "p1",
    raw_text: cell("We build lab-grown diagnostic sensors for rural clinics."),
    industry: cell("medical diagnostics"),
    technology: cell("electrochemical biosensor arrays"),
    location: cell("Boise, Idaho"),
    use_of_funds: cell("hire two engineers and buy manufacturing equipment"),
    capital_requirement: cell("250k_1m"),
    interview_answers: [],
  } as CompanyProfile;
}

const OPP: Opportunity = {
  id: "opp-1",
  source: "grants.gov",
  kind: "grant",
  program: "Advanced Diagnostics Grant",
  title: "Advanced Diagnostics for Rural Health",
  agency: "Department of Health and Human Services",
  description: "Grant for advanced diagnostic technology.",
  source_id: "HHS-2026-001",
};

/** A static, well-formed one-section draft with a grounded claim + an inline gap. */
function sampleDraft(): ApplicationDraft {
  return {
    opportunity_id: OPP.id,
    program_title: OPP.title!,
    generated_at: new Date().toISOString(),
    sections: [
      {
        key: "project_summary",
        title: "Project Summary",
        prompt: "Summarize your project.",
        draft_text:
          "We build electrochemical biosensor arrays for rural clinics. " +
          "Our annual revenue is [founder to provide: annual revenue].",
        claims: [
          { text: "We build electrochemical biosensor arrays for rural clinics.", profile_field: "technology" },
        ],
        gaps: [{ field_hint: "annual revenue", placeholder: "[founder to provide: annual revenue]" }],
      },
    ],
  };
}

const REQS: AutoFillRequirements = { ...EMPTY_AUTO_FILL_REQUIREMENTS };

// ---------------------------------------------------------------------------
// collectAllGaps — the single gap-summary surface (test requirement 1)
// ---------------------------------------------------------------------------

describe("collectAllGaps", () => {
  test("collects every [founder to provide: …] across narratives + forms + budget, each well-formed", () => {
    const profile = sampleProfile();
    const forms = prefillApplicationForms(profile, REQS, OPP);
    const budget = buildBudget(profile, undefined, OPP);
    const draft = sampleDraft();

    const gaps = collectAllGaps({ draft, forms, budget });

    // Every collected gap matches the exact placeholder shape.
    for (const g of gaps) assert.match(g, FOUNDER_TODO_PATTERN);

    // The narrative's inline gap is present.
    assert.ok(gaps.includes("[founder to provide: annual revenue]"));

    // Every forms gap and every budget gap is present (nothing dropped).
    for (const g of forms.gaps) assert.ok(gaps.includes(g), `missing forms gap: ${g}`);
    for (const g of budget.gaps) assert.ok(gaps.includes(g), `missing budget gap: ${g}`);

    // The set is deduplicated.
    assert.equal(gaps.length, new Set(gaps).size);
  });

  test("filters out any malformed (non-placeholder) entry defensively", () => {
    const profile = sampleProfile();
    const forms = prefillApplicationForms(profile, REQS, OPP);
    const budget = buildBudget(profile, undefined, OPP);
    // A draft whose section carries a non-placeholder inline string produces no
    // extra gap — scanFounderTodos only matches the exact shape.
    const draft: ApplicationDraft = {
      ...sampleDraft(),
      sections: [
        {
          key: "s",
          title: "S",
          prompt: "",
          draft_text: "No blanks here — just TODO: revenue (not a real placeholder).",
          claims: [],
          gaps: [],
        },
      ],
    };
    const gaps = collectAllGaps({ draft, forms, budget });
    assert.ok(!gaps.some((g) => g.includes("TODO")));
    for (const g of gaps) assert.match(g, FOUNDER_TODO_PATTERN);
  });
});

describe("scanFounderTodos", () => {
  test("finds each inline placeholder, keeping adjacent ones separate", () => {
    const found = scanFounderTodos("a [founder to provide: x] b [founder to provide: y] c");
    assert.deepEqual(found, ["[founder to provide: x]", "[founder to provide: y]"]);
  });
});

// ---------------------------------------------------------------------------
// assemblePackage — degraded path still yields forms+budget+checklist (req 3)
// ---------------------------------------------------------------------------

describe("assemblePackage", () => {
  test("full path: narratives + draftable list + gaps, narrativeStatus drafted", () => {
    const profile = sampleProfile();
    const forms = prefillApplicationForms(profile, REQS, OPP);
    const budget = buildBudget(profile, undefined, OPP);
    const draft = sampleDraft();

    const pkg = assemblePackage({
      opportunity_id: OPP.id,
      program_title: OPP.title!,
      forms,
      budget,
      checklist: { allRegistrationsSatisfied: false },
      narrativeSections: [
        { key: "project_summary", title: "Project Summary", prompt: "Summarize your project." },
        { key: "budget_narrative", title: "Budget Narrative", prompt: "Justify your budget." },
      ],
      draft,
      narrativeStatus: "drafted",
      requirementsAvailable: true,
    });

    assert.equal(pkg.narrativeStatus, "drafted");
    assert.equal(pkg.narratives.length, 1);
    // The section we drafted is NOT re-listed as draftable; the other one is.
    assert.deepEqual(pkg.draftableSections.map((s) => s.key), ["budget_narrative"]);
    assert.ok(pkg.gaps.includes("[founder to provide: annual revenue]"));
    assert.ok(pkg.gaps.length > 1);
  });

  test("degraded path: draft absent → forms+budget+checklist still present, narratives empty", () => {
    const profile = sampleProfile();
    const forms = prefillApplicationForms(profile, REQS, OPP);
    const budget = buildBudget(profile, undefined, OPP);

    const pkg = assemblePackage({
      opportunity_id: OPP.id,
      program_title: OPP.title!,
      forms,
      budget,
      checklist: { allRegistrationsSatisfied: false },
      narrativeSections: [],
      draft: null,
      narrativeStatus: "unavailable",
      narrativeNote: "model busy",
      requirementsAvailable: false,
    });

    assert.equal(pkg.narrativeStatus, "unavailable");
    assert.equal(pkg.narratives.length, 0);
    // The DETERMINISTIC parts survive a degraded model step.
    assert.ok(pkg.forms.forms.length > 0);
    assert.ok(pkg.budget.line_items.length > 0);
    assert.ok(pkg.checklist);
    // The gap summary still collects the forms + budget blanks.
    assert.ok(pkg.gaps.length > 0);
    for (const g of pkg.gaps) assert.match(g, FOUNDER_TODO_PATTERN);
  });
});

// ---------------------------------------------------------------------------
// Honest copy invariants (test requirement 2)
// ---------------------------------------------------------------------------

/** Positive submission/eligibility CONFIRMATIONS the package must never state.
 *  Mirrors the D6 ApplicationChecklist test; crafted NOT to match honest
 *  negations ("nothing was submitted", "no application was filed"). */
const SUBMIT_CONFIRMATION_PATTERNS: RegExp[] = [
  /application (has been |was )?submitted\b/i,
  /we (have |)submitted/i,
  /automatically submit/i,
  /you('ve| have) won\b/i,
  /application (was |has been )?approved\b/i,
  /you (are|'re) eligible/i,
  /you qualify/i,
];

describe("honest AOR hand-off + intro copy", () => {
  const allCopy = [
    AOR_HANDOFF.eyebrow,
    AOR_HANDOFF.headline,
    AOR_HANDOFF.body,
    AOR_HANDOFF.cta,
    PACKAGE_INTRO.eyebrow,
    PACKAGE_INTRO.note,
  ].join("  ");

  test("contains NO banned definitive-eligibility phrasing (reuses findBannedPhrases)", () => {
    assert.deepEqual(findBannedPhrases(allCopy), []);
  });

  test("contains NO submit/eligibility CONFIRMATION words", () => {
    for (const re of SUBMIT_CONFIRMATION_PATTERNS) {
      assert.doesNotMatch(allCopy, re, `copy unexpectedly matched ${re}`);
    }
  });

  test("ends on the honest 'Review & submit via your authorized AOR' hand-off", () => {
    assert.equal(AOR_HANDOFF.cta, "Review & submit via your authorized AOR");
    assert.match(AOR_HANDOFF.body, /nothing was submitted/i);
    assert.match(AOR_HANDOFF.body, /no application was filed/i);
    assert.match(AOR_HANDOFF.body, /authorized organization representative/i);
  });
});

// ---------------------------------------------------------------------------
// allRegistrationsSatisfied
// ---------------------------------------------------------------------------

describe("allRegistrationsSatisfied", () => {
  test("true only when all four SAM/UEI/AOR/E-Biz facts are on file", () => {
    assert.equal(allRegistrationsSatisfied(EMPTY_AUTO_FILL_REQUIREMENTS), false);
    const all: AutoFillRequirements = {
      samRegistered: true,
      samRegisteredDate: "",
      uei: "ABC123",
      aorName: "Jane Doe",
      aorOnFile: false,
      eBizPocOnFile: true,
    };
    assert.equal(allRegistrationsSatisfied(all), true);
    assert.equal(allRegistrationsSatisfied({ ...all, uei: "" }), false);
  });
});

// ---------------------------------------------------------------------------
// startupProfileToCompanyProfile — maps real fields, never fabricates
// ---------------------------------------------------------------------------

describe("startupProfileToCompanyProfile", () => {
  test("carries the founder's own extracted fields, leaving unknowns absent (honest gaps)", () => {
    const sp: StartupProfile = {
      description: "We build biosensors.",
      industry: "medical diagnostics",
      technology: "electrochemical biosensor arrays",
      location: "Boise, Idaho",
      useOfFunds: "hire engineers and buy equipment",
      capitalRequirement: "250k_1m",
      naicsGuesses: ["334516"],
    };
    const profile = startupProfileToCompanyProfile(sp);

    // Provided fields map through and read as "provided".
    assert.ok(isFieldProvided(profile, "industry"));
    assert.ok(isFieldProvided(profile, "technology"));
    assert.ok(isFieldProvided(profile, "use_of_funds"));
    assert.ok(isFieldProvided(profile, "capital_requirement"));
    assert.ok(isFieldProvided(profile, "naics_codes"));
    assert.equal(profile.use_of_funds?.value, "hire engineers and buy equipment");

    // Fields the v1 profile never carries stay ABSENT — never fabricated.
    assert.equal(isFieldProvided(profile, "entity_type"), false);
    assert.equal(isFieldProvided(profile, "uei"), false);
  });

  test("threads self-reported SAM/UEI registration facts as user_stated", () => {
    const profile = startupProfileToCompanyProfile(
      { description: "x" },
      { samRegistered: true, samRegisteredDate: "", uei: "XYZ789", aorName: "", aorOnFile: false, eBizPocOnFile: false },
    );
    assert.equal(profile.sam_registered?.value, true);
    assert.equal(profile.sam_registered?.provenance, "user_stated");
    assert.equal(profile.uei?.value, "XYZ789");
  });

  test("an empty/undefined profile yields a minimal but valid CompanyProfile (all gaps)", () => {
    const profile = startupProfileToCompanyProfile(undefined);
    assert.equal(profile.id, "v1-startup-profile");
    assert.equal(isFieldProvided(profile, "industry"), false);
    assert.equal(isFieldProvided(profile, "use_of_funds"), false);
  });
});
