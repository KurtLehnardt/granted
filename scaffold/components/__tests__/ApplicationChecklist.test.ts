import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import React from "react";
import type { Match, Opportunity } from "../../lib/types";
import ApplicationChecklist, {
  buildApplicationChecklist,
  buildDocumentChecklist,
  buildFundingRange,
  buildKeyDates,
  buildNextSteps,
  buildQuestions,
  opportunityOnlyMatch,
  stepText,
} from "../ApplicationChecklist";

// Fixed "now" so deadline-relative assertions don't depend on the actual clock.
const NOW = Date.parse("2026-09-27T00:00:00.000Z");

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

function asMatch(opportunity: Opportunity, overrides: Partial<Match> = {}): Match {
  return { ...opportunityOnlyMatch(opportunity), ...overrides };
}

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

// Two grants.gov grants — same source and kind, different dates/funding.
const GRANTS_GOV_OPEN: Opportunity = {
  id: "grants-open-1",
  source: "grants.gov",
  kind: "grant",
  program: "Mathematical Foundations of Artificial Intelligence",
  agency: "U.S. National Science Foundation",
  description: "Research collaborations on the mathematical foundations of AI.",
  eligibility: "Institutions of higher education and non-profit research organizations.",
  fundingLow: 500_000,
  fundingHigh: 1_500_000,
  deadline: "10/09/2026",
  forecasted: false,
  url: "https://www.grants.gov/search-results-detail/353936",
};

// Same record as GRANTS_GOV_OPEN but its deadline is behind NOW.
const GRANTS_GOV_PASSED: Opportunity = {
  ...GRANTS_GOV_OPEN,
  id: "grants-passed-1",
  deadline: "09/11/2026",
};

const GRANTS_GOV_CLOSED: Opportunity = {
  ...GRANTS_GOV_OPEN,
  id: "grants-closed-1",
  status: "closed",
};

const GRANTS_GOV_FORECASTED: Opportunity = {
  id: "grants-forecast-1",
  source: "grants.gov",
  kind: "grant",
  program: "Annual Program Statement (APS) For Fiscal Year 2026",
  agency: "U.S. Mission to Tunisia",
  description: "Public diplomacy small grants for FY2026.",
  eligibility: "Not-for-profit organizations and educational institutions.",
  fundingLow: 10_000,
  fundingHigh: 200_000,
  forecasted: true,
  url: "https://www.grants.gov/search-results-detail/362086",
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

  test("never fabricates a date — an opportunity with no dates, forecasted flag, or status shows an honest empty row", () => {
    const dates = buildKeyDates(BARE_OPPORTUNITY);
    assert.equal(dates.length, 1);
    assert.equal(dates[0].label, "Deadline");
    assert.equal(dates[0].value, null);
  });

  test("a forecasted opportunity with no deadline says so, using its own flag", () => {
    const dates = buildKeyDates(GRANTS_GOV_FORECASTED);
    assert.equal(dates.length, 1);
    assert.match(dates[0].value ?? "", /forecasted/i);
  });

  test("a continuous-status opportunity with no deadline shows an honest empty row, not an invented 'no deadline' claim", () => {
    const dates = buildKeyDates({ ...BARE_OPPORTUNITY, status: "continuous" });
    assert.equal(dates.length, 1);
    assert.equal(dates[0].label, "Deadline");
    assert.equal(dates[0].value, null);
  });
});

// ---------------------------------------------------------------------------
// buildFundingRange
// ---------------------------------------------------------------------------

describe("buildFundingRange", () => {
  test("formats a low+high range", () => {
    assert.equal(buildFundingRange(GRANTS_GOV_OPEN), "$500K–$1.5M");
  });

  test("never fabricates a range when neither bound is present", () => {
    assert.equal(buildFundingRange(BARE_OPPORTUNITY), null);
  });

  test("a one-sided range never reads as $X–$0", () => {
    assert.equal(buildFundingRange({ ...BARE_OPPORTUNITY, fundingHigh: 250_000 }), "up to $250K");
    assert.equal(buildFundingRange({ ...BARE_OPPORTUNITY, fundingLow: 500_000, fundingHigh: 0 }), "$500K+");
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

  test("states the actual funding range in the budget question when known", () => {
    const questions = buildQuestions(GRANTS_GOV_OPEN);
    assert.ok(questions.some((q) => q.includes("$500K–$1.5M")));
  });
});

// ---------------------------------------------------------------------------
// buildNextSteps
// ---------------------------------------------------------------------------

describe("buildNextSteps", () => {
  test("always ends by pointing to the opportunity's official portal", () => {
    const steps = buildNextSteps(asMatch(RD_OPPORTUNITY));
    assert.match(stepText(steps[steps.length - 1]), /official portal/i);
  });

  test("always includes the generic SAM.gov/UEI/AOR/E-Biz registration reminder", () => {
    const steps = buildNextSteps(asMatch(RD_OPPORTUNITY)).map(stepText);
    assert.ok(steps.some((s) => /SAM\.gov registration is Active/i.test(s)));
  });

  test("points at the opportunity's own URL as a real link when present, else names the source", () => {
    const withUrl = buildNextSteps(asMatch(RD_OPPORTUNITY));
    const withoutUrl = buildNextSteps(asMatch(GRANT_OPPORTUNITY));
    const linkPart = withUrl[0].find((p) => typeof p !== "string") as { text: string; href: string } | undefined;
    assert.ok(linkPart);
    assert.equal(linkPart!.href, RD_OPPORTUNITY.url);
    assert.ok(withoutUrl[0].every((p) => typeof p === "string"));
    assert.ok(stepText(withoutUrl[0]).includes(GRANT_OPPORTUNITY.source));
  });

  test("threads the match's own whatToVerify/whatToDoNext into the steps, without inventing them, labeled as the match assessment", () => {
    const withNarrative = buildNextSteps(
      asMatch(RD_OPPORTUNITY, { whatToVerify: "Confirm your NAICS code matches this topic.", whatToDoNext: "Reach out to the program manager listed on the topic page." }),
    ).map(stepText);
    const withoutNarrative = buildNextSteps(asMatch(RD_OPPORTUNITY)).map(stepText);
    assert.ok(
      withNarrative.some(
        (s) => s.startsWith("From your match assessment, before applying verify: ") && s.includes("Confirm your NAICS code matches this topic."),
      ),
    );
    assert.ok(
      withNarrative.some(
        (s) => s.startsWith("From your match assessment: ") && s.includes("Reach out to the program manager listed on the topic page."),
      ),
    );
    assert.notEqual(withNarrative.length, withoutNarrative.length);
  });

  test("apply-path step is source-specific, not a shared template", () => {
    const sbirStep = stepText(buildNextSteps(asMatch(RD_OPPORTUNITY))[0]);
    const grantsGovStep = stepText(buildNextSteps(asMatch(GRANT_OPPORTUNITY))[0]);
    const samContractsStep = stepText(
      buildNextSteps(asMatch({ ...BARE_OPPORTUNITY, source: "sam-contracts", kind: "procurement" }))[0],
    );
    const assistanceStep = stepText(buildNextSteps(asMatch(BARE_OPPORTUNITY))[0]);

    assert.match(sbirStep, /Register in SAM\.gov and on sbir\.gov/i);
    assert.doesNotMatch(sbirStep, /not grants\.gov/i);
    assert.match(grantsGovStep, /grants\.gov \(an Active SAM\.gov registration/i);
    assert.match(samContractsStep, /SAM\.gov Contract Opportunities/i);
    assert.match(assistanceStep, /assistance listing describes a program/i);
    assert.doesNotMatch(assistanceStep, /not a competed application/i);

    assert.notEqual(sbirStep, grantsGovStep);
    assert.notEqual(sbirStep, samContractsStep);
    assert.notEqual(sbirStep, assistanceStep);
    assert.notEqual(grantsGovStep, samContractsStep);
  });

  test("a SBIR/STTR step is a real apply step (agency solicitation page + deadline), never an awardee/background label", () => {
    const step = buildNextSteps(
      asMatch({ ...RD_OPPORTUNITY, url: "https://www.example-agency.gov/solicitation/123", deadline: "2026-11-01" }),
    )[0];
    const text = stepText(step);
    assert.doesNotMatch(text, /this opportunity's page/i);
    assert.doesNotMatch(text, /not grants\.gov/i);
    assert.doesNotMatch(text, /Awardee/i);
    assert.doesNotMatch(text, /background, not an application portal/i);
    assert.match(text, /Register in SAM\.gov and on sbir\.gov/i);
    assert.match(text, /before its deadline of \w+ \d{1,2}, 2026/i);
    const linkPart = step.find((p) => typeof p !== "string") as { text: string; href: string } | undefined;
    assert.equal(linkPart?.href, "https://www.example-agency.gov/solicitation/123");
    assert.equal(linkPart?.text, "the agency's solicitation page");
  });

  test("a bare-domain SBIR url (no http/https scheme) falls back to the generic listing pointer, never a broken relative link", () => {
    const step = buildNextSteps(asMatch({ ...RD_OPPORTUNITY, url: "www.example-agency.gov/solicitation/123" }))[0];
    const linkPart = step.find((p) => typeof p !== "string");
    assert.equal(linkPart, undefined);
    const text = stepText(step);
    assert.match(text, /the full listing \(source: sbir\)/i);
  });

  test("a SBIR/STTR record with no URL and no deadline still gives a real apply step, with the generic listing pointer", () => {
    const step = buildNextSteps(asMatch({ ...RD_OPPORTUNITY, url: undefined, deadline: undefined }))[0];
    assert.equal(
      stepText(step),
      "Register in SAM.gov and on sbir.gov (most agencies require both before you can submit), then read and apply through the full listing (source: sbir). No deadline is listed — confirm the submission window on the agency page.",
    );
  });

  test("a USAspending record (never matchable, but defensively) falls to the generic apply step, not a past-award label", () => {
    const url = "https://www.usaspending.gov/award/CONT_AWD_W911QX25C0002_9700_-NONE-_-NONE-";
    const step = buildNextSteps(
      asMatch({ ...BARE_OPPORTUNITY, source: "usaspending", kind: "procurement", status: "closed", url }),
    )[0];
    assert.match(stepText(step), /Read the full opportunity listing at/i);
  });

  test("a forecasted grants.gov opportunity is described as not yet open, using its own flag — not a fixed deadline claim", () => {
    const step = stepText(buildNextSteps(asMatch(GRANTS_GOV_FORECASTED))[0]);
    assert.match(step, /forecasted/i);
    assert.match(step, /not yet open/i);
    assert.doesNotMatch(step, /before its deadline/i);
  });

  test("an open grants.gov opportunity with a real deadline states it, linked to its own page", () => {
    const rawStep = buildNextSteps(asMatch(GRANTS_GOV_OPEN), NOW)[0];
    const step = stepText(rawStep);
    assert.match(step, /before its deadline/i);
    assert.doesNotMatch(step, /forecasted/i);
    assert.doesNotMatch(step, /has already passed/i);
    const linkPart = rawStep.find((p) => typeof p !== "string") as { text: string; href: string } | undefined;
    assert.equal(linkPart?.href, GRANTS_GOV_OPEN.url);
  });

  test("a grants.gov opportunity that's open but has no listed deadline says so honestly", () => {
    const step = stepText(buildNextSteps(asMatch({ ...GRANTS_GOV_OPEN, deadline: undefined }), NOW)[0]);
    assert.match(step, /no deadline is listed/i);
  });

  test("a grants.gov opportunity whose deadline has already passed says so and points at checking for a reissue, not 'apply before'", () => {
    const step = stepText(buildNextSteps(asMatch(GRANTS_GOV_PASSED), NOW)[0]);
    assert.match(step, /deadline of .* has already passed/i);
    assert.match(step, /reissue/i);
    assert.doesNotMatch(step, /Register on grants\.gov \(an Active/i);
    assert.doesNotMatch(step, /before its deadline/i);
  });

  test("a grants.gov opportunity marked closed says so, distinctly from a passed-deadline one", () => {
    const step = stepText(buildNextSteps(asMatch(GRANTS_GOV_CLOSED), NOW)[0]);
    assert.match(step, /marked closed/i);
    assert.match(step, /reissue/i);
    assert.doesNotMatch(step, /has already passed/i);
  });
});

// ---------------------------------------------------------------------------
// buildApplicationChecklist — integration of the above
// ---------------------------------------------------------------------------

describe("buildApplicationChecklist", () => {
  test("prefers the §3.4 `title` field over the legacy `program` field", () => {
    const model = buildApplicationChecklist(asMatch(RD_OPPORTUNITY));
    assert.equal(model.title, RD_OPPORTUNITY.title);
  });

  test("falls back to `program` when `title` is absent", () => {
    const model = buildApplicationChecklist(asMatch(GRANT_OPPORTUNITY));
    assert.equal(model.title, GRANT_OPPORTUNITY.program);
  });

  test("different opportunities produce different checklists (per-opportunity, not a shared template)", () => {
    const rdModel = buildApplicationChecklist(asMatch(RD_OPPORTUNITY));
    const grantModel = buildApplicationChecklist(asMatch(GRANT_OPPORTUNITY));
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
    const grantsGovModel = buildApplicationChecklist(asMatch(GRANT_OPPORTUNITY));
    const assistanceModel = buildApplicationChecklist(asMatch(sameKindDifferentSource));
    assert.equal(grantsGovModel.documents.join(), assistanceModel.documents.join()); // same kind -> same docs
    assert.notEqual(stepText(grantsGovModel.nextSteps[0]), stepText(assistanceModel.nextSteps[0])); // different source -> different apply step
  });

  // Same source and kind must still produce meaningfully different content.
  test("two SAME-SOURCE, SAME-KIND grants.gov opportunities produce meaningfully different content", () => {
    const openModel = buildApplicationChecklist(
      asMatch(GRANTS_GOV_OPEN, { whatToVerify: "Your PI holds a qualifying faculty appointment." }),
      NOW,
    );
    const forecastedModel = buildApplicationChecklist(
      asMatch(GRANTS_GOV_FORECASTED, { whatToVerify: "Your programming has an American cultural element." }),
      NOW,
    );
    const openStep0 = stepText(openModel.nextSteps[0]);
    const forecastedStep0 = stepText(forecastedModel.nextSteps[0]);

    assert.notEqual(openModel.fundingRange, forecastedModel.fundingRange);
    assert.notEqual(JSON.stringify(openModel.keyDates), JSON.stringify(forecastedModel.keyDates));
    assert.notEqual(openModel.questions.join(), forecastedModel.questions.join());
    assert.notEqual(openStep0, forecastedStep0);
    assert.notEqual(openModel.nextSteps.map(stepText).join(), forecastedModel.nextSteps.map(stepText).join());

    // Strip the title/url so the remaining diff isn't just those two fields.
    const stripIdentity = (s: string) =>
      s
        .replaceAll(GRANTS_GOV_OPEN.program, "")
        .replaceAll(GRANTS_GOV_FORECASTED.program, "")
        .replaceAll(GRANTS_GOV_OPEN.url as string, "")
        .replaceAll(GRANTS_GOV_FORECASTED.url as string, "");
    assert.notEqual(stripIdentity(openStep0), stripIdentity(forecastedStep0));
  });
});

// ---------------------------------------------------------------------------
// <ApplicationChecklist/> — rendered smoke test (no jsdom needed;
// renderToStaticMarkup only needs React, not a DOM).
// ---------------------------------------------------------------------------

describe("<ApplicationChecklist/> render", () => {
  test("renders the selected opportunity's own title and agency", () => {
    const html = renderToStaticMarkup(
      React.createElement(ApplicationChecklist, { match: asMatch(RD_OPPORTUNITY) }),
    );
    assert.ok(html.includes(RD_OPPORTUNITY.title as string));
    assert.ok(html.includes(RD_OPPORTUNITY.agency));
  });

  test("is honestly labeled as a preparation checklist", () => {
    const html = renderToStaticMarkup(
      React.createElement(ApplicationChecklist, { match: asMatch(RD_OPPORTUNITY) }),
    );
    assert.match(html, /preparation checklist/i);
  });

  test("never claims a submission happened or an award was won, for any opportunity", () => {
    for (const opp of [RD_OPPORTUNITY, GRANT_OPPORTUNITY, BARE_OPPORTUNITY]) {
      const html = renderToStaticMarkup(
        React.createElement(ApplicationChecklist, { match: asMatch(opp) }),
      );
      assert.doesNotMatch(html, /application (has been |was )?submitted\b/i);
      assert.doesNotMatch(html, /we (have |)submitted/i);
      assert.doesNotMatch(html, /automatically submit/i);
      assert.doesNotMatch(html, /you('ve| have) won/i);
      assert.doesNotMatch(html, /you (are|'re) eligible/i);
      assert.doesNotMatch(html, /you qualify/i);
    }
  });

  test("renders the opportunity's url as a real clickable link, not plain text", () => {
    const html = renderToStaticMarkup(
      React.createElement(ApplicationChecklist, { match: asMatch(RD_OPPORTUNITY) }),
    );
    assert.match(html, new RegExp(`<a[^>]*href="${RD_OPPORTUNITY.url}"`));
  });

  test("labels the match's whatToDoNext as coming from the match assessment", () => {
    const html = renderToStaticMarkup(
      React.createElement(ApplicationChecklist, {
        match: asMatch(RD_OPPORTUNITY, { whatToDoNext: "Reach out to the program manager listed on the topic page." }),
      }),
    );
    assert.match(html, /From your match assessment: Reach out to the program manager/i);
  });
});
