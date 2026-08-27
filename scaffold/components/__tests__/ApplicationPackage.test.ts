import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import React from "react";

import { ApplicationPackageView } from "../ApplicationPackage";
import type { Opportunity } from "../../lib/types";
import type { CompanyProfile } from "../../lib/contracts/companyProfile";
import type { ApplicationDraft } from "../../lib/contracts/applicationDraft";
import { EMPTY_AUTO_FILL_REQUIREMENTS } from "../../lib/mockAuth";
import { prefillApplicationForms } from "../../lib/apply/forms";
import { buildBudget } from "../../lib/apply/budget";
import { assemblePackage, type AssembledPackage } from "../../lib/apply/package";
// Reuse the SAME check:prompts machinery — not a parallel linter.
import { findBannedPhrases } from "../../scripts/check-prompt-registry.mjs";

/**
 * G5 component tests — hermetic, NO network. `<ApplicationPackageView/>` is the
 * pure presentational split of `<ApplicationPackage/>`, so a static fixture
 * package renders synchronously via `renderToStaticMarkup` (no DOM, no fetch).
 * Covers the R7.7 honesty boundary: gaps highlighted, no submit/eligibility
 * CONFIRMATION, honest AOR hand-off, and the degraded path still shows the
 * deterministic parts.
 */

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

function fullPackage(): AssembledPackage {
  const profile = sampleProfile();
  return assemblePackage({
    opportunity_id: OPP.id,
    program_title: OPP.title!,
    forms: prefillApplicationForms(profile, EMPTY_AUTO_FILL_REQUIREMENTS, OPP),
    budget: buildBudget(profile, undefined, OPP),
    checklist: { allRegistrationsSatisfied: false },
    narrativeSections: [{ key: "project_summary", title: "Project Summary", prompt: "Summarize your project." }],
    draft: sampleDraft(),
    narrativeStatus: "drafted",
    requirementsAvailable: true,
  });
}

function degradedPackage(): AssembledPackage {
  const profile = sampleProfile();
  return assemblePackage({
    opportunity_id: OPP.id,
    program_title: OPP.title!,
    forms: prefillApplicationForms(profile, EMPTY_AUTO_FILL_REQUIREMENTS, OPP),
    budget: buildBudget(profile, undefined, OPP),
    checklist: { allRegistrationsSatisfied: false },
    narrativeSections: [],
    draft: null,
    narrativeStatus: "unavailable",
    narrativeNote: "The drafting model was busy — retry to add the narrative drafts.",
    requirementsAvailable: false,
  });
}

function render(pkg: AssembledPackage): string {
  return renderToStaticMarkup(
    React.createElement(ApplicationPackageView, { pkg, opportunity: OPP }),
  );
}

/** Positive submission/eligibility CONFIRMATIONS the view must never render.
 *  Crafted (like the D6 test) NOT to match honest negations. */
const SUBMIT_CONFIRMATION_PATTERNS: RegExp[] = [
  /application (has been |was )?submitted\b/i,
  /we (have |)submitted/i,
  /automatically submit/i,
  /you('ve| have) won\b/i,
  /application (was |has been )?approved\b/i,
  /you (are|'re) eligible/i,
  /you qualify/i,
];

describe("<ApplicationPackageView/> honesty", () => {
  test("highlights every [founder to provide: …] gap as a warning pill", () => {
    const html = render(fullPackage());
    // The pill token class is present, and the narrative's own gap is shown.
    assert.match(html, /bg-warning/);
    assert.ok(html.includes("[founder to provide: annual revenue]"));
  });

  test("renders NO submit/eligibility CONFIRMATION, for the full package", () => {
    const html = render(fullPackage());
    for (const re of SUBMIT_CONFIRMATION_PATTERNS) {
      assert.doesNotMatch(html, re, `rendered markup unexpectedly matched ${re}`);
    }
  });

  test("renders NO banned definitive-eligibility phrasing (reuses findBannedPhrases)", () => {
    // Strip tags so text content (not attribute noise) is scanned.
    const text = render(fullPackage()).replace(/<[^>]+>/g, " ");
    assert.deepEqual(findBannedPhrases(text), []);
  });

  test("ends on the honest AOR hand-off — nothing submitted, no application filed", () => {
    const html = render(fullPackage());
    assert.match(html, /Review &amp; submit via your authorized AOR/);
    assert.match(html, /nothing was submitted/i);
    assert.match(html, /no application was filed/i);
  });
});

describe("<ApplicationPackageView/> degraded path", () => {
  test("still renders forms + budget + checklist when narratives are unavailable", () => {
    const pkg = degradedPackage();
    const html = render(pkg);

    // Narrative degraded note is shown instead of drafts.
    assert.match(html, /couldn't draft|model was busy|aren't available/i);
    // The DETERMINISTIC parts render regardless.
    assert.match(html, /Pre-filled forms/);
    assert.match(html, /Budget/);
    // The reused D6 checklist renders (its own honest label).
    assert.match(html, /Preparation checklist/);
    // Still no confirmation of a submission.
    for (const re of SUBMIT_CONFIRMATION_PATTERNS) {
      assert.doesNotMatch(html, re);
    }
  });
});
