import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import React from "react";
import CompetitorResults from "../CompetitorResults";

/** A minimal, fully-grounded fixture (real schema shape) — mirrors
 *  lib/contracts/__tests__/competitorAnalysis.test.ts's own fixture. */
function fixture() {
  return {
    persona: "Acme QMS",
    personaDescription: "A Utah company building cloud QMS/MES software for regulated life sciences.",
    capturedAt: "2026-08-15T18:35:24.229Z",
    records: [
      {
        id: "usa_1",
        source: "USAspending",
        recipient: "QUALTRAX, INC",
        amount: 71084,
        agency: "Environmental Protection Agency",
        abstract: "The system will support the CRL's ISO/IEC 17025 accreditation by managing quality through document control and workflows.",
        sourceUrl: "https://www.usaspending.gov/award/CONT_AWD_EP135000141_6800_-NONE-_-NONE-",
      },
    ],
    analysis: {
      competitors: [
        { recordId: "usa_1", positioning: "Qualtrax won EPA business by aligning document control to ISO/IEC 17025.", quotedSnippet: "managing quality through document control and workflows" },
      ],
      recommendations: [{ advice: "Target lab QMS compliance contracts.", citations: ["usa_1"] }],
    },
  };
}

function render() {
  return renderToStaticMarkup(React.createElement(CompetitorResults, { raw: fixture() }));
}

describe("CompetitorResults — export/prompt actions", () => {
  test("Export as PDF and Draft a grant-proposal prompt both render", () => {
    const html = render();
    assert.match(html, />Export as PDF</);
    assert.match(html, />Draft a grant-proposal prompt</);
  });

  test("the prompt section is collapsed by default -- no prompt text, no Copy/Export-prompt buttons", () => {
    const html = render();
    assert.doesNotMatch(html, /Grant-proposal prompt</);
    assert.doesNotMatch(html, />Copy to clipboard</);
  });

  test("the root carries the print-isolation class for the whole-analysis export", () => {
    const html = render();
    assert.match(html, /class="print-section-competitor-analysis/);
  });

  test("a thrown (ungrounded) payload still throws before any of this renders -- unaffected by the new actions", () => {
    const bad = fixture();
    bad.analysis.competitors[0].recordId = "ghost_99";
    assert.throws(() => renderToStaticMarkup(React.createElement(CompetitorResults, { raw: bad })));
  });
});
