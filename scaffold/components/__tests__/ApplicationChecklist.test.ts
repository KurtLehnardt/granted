import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import React from "react";
import type { Opportunity } from "../../lib/types";
import ApplicationChecklist, {
  buildApplicationChecklist,
  buildDocumentChecklist,
  buildKeyDates,
  buildNextSteps,
  buildQuestions,
} from "../ApplicationChecklist";

/**
 * D6 — Application Assistant checklist. Covers:
 *  - per-opportunity rendering (different opportunities -> different content)
 *  - the R7.7 honesty boundary: never claims a submission happened, never
 *    renders an eligibility verdict, never fabricates a date that wasn't on
 *    the record.
 *
 * No component test glob exists yet in package.json's `test` script (it only
 * covers lib/**, app/**, scripts/** — components/ isn't included). This file
 * still follows the repo's established `__tests__/*.test.ts` convention and
 * runs cleanly stand-alone via:
 *   node --import tsx --test "components/__tests__/ApplicationChecklist.test.ts"
 * Wiring components/** into the `test` script is outside D6's file scope
 * (package.json isn't in the allowed file list) — see the D6 report.
 */

const RD_OPPORTUNITY: Opportunity = {
  id: "opp-rd-1",
  source: "sbir",
  kind: "rd",
  program: "Small Business Innovation Research — Phase I",
  title: "SBIR Phase I: Advanced Materials",
  agency: "Department of Energy",
  description: "R&D funding for advanced materials research.",
  eligibility: "Must be a US-owned, for-profit small business with fewer than 500 employees.",
  url: "https://example.gov/opportunities/opp-rd-1",
  fundingLow: 50_000,
  fundingHigh: 250_000,
  key_dates: {
    open_date: "2026-01-15T00:00:00.000Z",
    close_date: "2026-03-01T00:00:00.000Z",
  },
};

const GRANT_OPPORTUNITY: Opportunity = {
  id: "opp-grant-1",
  source: "grants.gov",
  kind: "grant",
  program: "Community Development Block Grant",
  agency: "Department of Housing and Urban Development",
  description: "Formula grant for community development activities.",
  deadline: "2026-06-30",
  forecasted: true,
};

const BARE_OPPORTUNITY: Opportunity = {
  id: "opp-bare-1",
  source: "assistance-listings",
  kind: "assistance",
  program: "Untitled Assistance Program",
  agency: "Example Agency",
  description: "No dates on file.",
};

// ---------------------------------------------------------------------------
// buildKeyDates
// ---------------------------------------------------------------------------

describe("buildKeyDates", () => {
  test("prefers structured key_dates over the legacy deadline field", () => {
    const dates = buildKeyDates(RD_OPPORTUNITY);
    const labels = dates.map((d) => d.label);
    assert.deepEqual(labels, ["Opens", "Closes"]);
    assert.ok(dates[0].value?.includes("2026"));
    assert.ok(dates[1].value?.includes("2026"));
  });

  test("falls back to the legacy deadline field when key_dates is absent", () => {
    const dates = buildKeyDates(GRANT_OPPORTUNITY);
    assert.equal(dates.length, 1);
    assert.equal(dates[0].label, "Forecasted deadline");
    assert.ok(dates[0].value?.includes("2026"));
  });

  test("never fabricates a date — an opportunity with no dates on file shows an honest empty row", () => {
    const dates = buildKeyDates(BARE_OPPORTUNITY);
    assert.equal(dates.length, 1);
    assert.equal(dates[0].label, "Deadline");
    assert.equal(dates[0].value, null);
  });
});

// ---------------------------------------------------------------------------
// buildDocumentChecklist
// ---------------------------------------------------------------------------

describe("buildDocumentChecklist", () => {
  test("R&D opportunities get technical-volume guidance a plain grant does not", () => {
    const rdDocs = buildDocumentChecklist(RD_OPPORTUNITY);
    const grantDocs = buildDocumentChecklist(GRANT_OPPORTUNITY);
    assert.ok(rdDocs.some((d) => /technical volume/i.test(d)));
    assert.ok(!grantDocs.some((d) => /technical volume/i.test(d)));
    // Base documents present in both.
    assert.ok(rdDocs.some((d) => /SF-424/.test(d)));
    assert.ok(grantDocs.some((d) => /SF-424/.test(d)));
  });
});

// ---------------------------------------------------------------------------
// buildQuestions
// ---------------------------------------------------------------------------

describe("buildQuestions", () => {
  test("quotes the opportunity's own eligibility prose when present, verbatim", () => {
    const questions = buildQuestions(RD_OPPORTUNITY);
    assert.ok(questions.some((q) => q.includes(RD_OPPORTUNITY.eligibility as string)));
  });

  test("never renders a self-generated eligibility verdict ('you are eligible' / 'you qualify')", () => {
    for (const opp of [RD_OPPORTUNITY, GRANT_OPPORTUNITY, BARE_OPPORTUNITY]) {
      const text = buildQuestions(opp).join(" ");
      assert.doesNotMatch(text, /you (are|'re) eligible/i);
      assert.doesNotMatch(text, /you qualify/i);
    }
  });

  test("omits the eligibility-quote question when the opportunity has no eligibility prose", () => {
    const questions = buildQuestions(GRANT_OPPORTUNITY);
    assert.ok(!questions.some((q) => q.startsWith('The listing states:')));
  });
});

// ---------------------------------------------------------------------------
// buildNextSteps
// ---------------------------------------------------------------------------

describe("buildNextSteps", () => {
  test("always ends with the honesty boundary: this checklist never submits anything", () => {
    const steps = buildNextSteps(RD_OPPORTUNITY, true);
    assert.match(steps[steps.length - 1], /never submits anything on your behalf/i);
  });

  test("wording reflects whether registrations are satisfied, without changing the honesty boundary step", () => {
    const satisfiedSteps = buildNextSteps(RD_OPPORTUNITY, true);
    const unsatisfiedSteps = buildNextSteps(RD_OPPORTUNITY, false);
    assert.notEqual(satisfiedSteps[1], unsatisfiedSteps[1]);
    assert.match(unsatisfiedSteps[1], /complete the registrations/i);
    assert.match(satisfiedSteps[1], /marked satisfied/i);
  });

  test("points at the opportunity's own URL when present, else names the source", () => {
    const withUrl = buildNextSteps(RD_OPPORTUNITY, true);
    const withoutUrl = buildNextSteps(GRANT_OPPORTUNITY, true);
    assert.ok(withUrl[0].includes(RD_OPPORTUNITY.url as string));
    assert.ok(withoutUrl[0].includes(GRANT_OPPORTUNITY.source));
  });

  test("apply-path step is source-specific, not a shared template", () => {
    const sbirStep = buildNextSteps(RD_OPPORTUNITY, true)[0];
    const grantsGovStep = buildNextSteps(GRANT_OPPORTUNITY, true)[0];
    const samContractsStep = buildNextSteps(
      { ...BARE_OPPORTUNITY, source: "sam-contracts", kind: "procurement" },
      true,
    )[0];
    const assistanceStep = buildNextSteps(BARE_OPPORTUNITY, true)[0];

    assert.match(sbirStep, /SBIR\/STTR solicitation topic/i);
    assert.match(grantsGovStep, /grants\.gov \(an Active SAM\.gov registration/i);
    assert.match(samContractsStep, /SAM\.gov Contract Opportunities/i);
    assert.match(assistanceStep, /assistance listing, not a competed application/i);

    assert.notEqual(sbirStep, grantsGovStep);
    assert.notEqual(sbirStep, samContractsStep);
    assert.notEqual(sbirStep, assistanceStep);
    assert.notEqual(grantsGovStep, samContractsStep);
  });
});

// ---------------------------------------------------------------------------
// buildApplicationChecklist — integration of the above
// ---------------------------------------------------------------------------

describe("buildApplicationChecklist", () => {
  test("prefers the §3.4 `title` field over the legacy `program` field", () => {
    const model = buildApplicationChecklist(RD_OPPORTUNITY, true);
    assert.equal(model.title, RD_OPPORTUNITY.title);
  });

  test("falls back to `program` when `title` is absent", () => {
    const model = buildApplicationChecklist(GRANT_OPPORTUNITY, true);
    assert.equal(model.title, GRANT_OPPORTUNITY.program);
  });

  test("different opportunities produce different checklists (per-opportunity, not a shared template)", () => {
    const rdModel = buildApplicationChecklist(RD_OPPORTUNITY, true);
    const grantModel = buildApplicationChecklist(GRANT_OPPORTUNITY, true);
    assert.notEqual(rdModel.title, grantModel.title);
    assert.notEqual(JSON.stringify(rdModel.keyDates), JSON.stringify(grantModel.keyDates));
    assert.notEqual(JSON.stringify(rdModel.documents), JSON.stringify(grantModel.documents));
    assert.notEqual(JSON.stringify(rdModel.nextSteps), JSON.stringify(grantModel.nextSteps));
  });

  test("two opportunities of the SAME kind but different sources still get different apply guidance", () => {
    const sameKindDifferentSource: Opportunity = {
      ...GRANT_OPPORTUNITY,
      id: "opp-grant-2",
      source: "assistance-listings",
      program: "Rural Assistance Program",
    };
    const grantsGovModel = buildApplicationChecklist(GRANT_OPPORTUNITY, true);
    const assistanceModel = buildApplicationChecklist(sameKindDifferentSource, true);
    assert.equal(grantsGovModel.documents.join(), assistanceModel.documents.join()); // same kind -> same docs
    assert.notEqual(grantsGovModel.nextSteps[0], assistanceModel.nextSteps[0]); // different source -> different apply step
  });
});

// ---------------------------------------------------------------------------
// <ApplicationChecklist/> — rendered smoke test (no jsdom needed;
// renderToStaticMarkup only needs React, not a DOM).
// ---------------------------------------------------------------------------

describe("<ApplicationChecklist/> render", () => {
  test("renders the selected opportunity's own title and agency", () => {
    const html = renderToStaticMarkup(
      React.createElement(ApplicationChecklist, { opportunity: RD_OPPORTUNITY, allRegistrationsSatisfied: false }),
    );
    assert.ok(html.includes(RD_OPPORTUNITY.title as string));
    assert.ok(html.includes(RD_OPPORTUNITY.agency));
  });

  test("is honestly labeled as a preparation checklist, not a submission", () => {
    const html = renderToStaticMarkup(
      React.createElement(ApplicationChecklist, { opportunity: RD_OPPORTUNITY, allRegistrationsSatisfied: false }),
    );
    assert.match(html, /preparation checklist/i);
    assert.match(html, /not a submission/i);
  });

  test("never claims a submission happened or an award was won, for any opportunity", () => {
    for (const opp of [RD_OPPORTUNITY, GRANT_OPPORTUNITY, BARE_OPPORTUNITY]) {
      const html = renderToStaticMarkup(
        React.createElement(ApplicationChecklist, { opportunity: opp, allRegistrationsSatisfied: true }),
      );
      assert.doesNotMatch(html, /application (has been |was )?submitted\b/i);
      assert.doesNotMatch(html, /we (have |)submitted/i);
      assert.doesNotMatch(html, /automatically submit/i);
      assert.doesNotMatch(html, /you('ve| have) won/i);
      assert.doesNotMatch(html, /you (are|'re) eligible/i);
      assert.doesNotMatch(html, /you qualify/i);
    }
  });
});
