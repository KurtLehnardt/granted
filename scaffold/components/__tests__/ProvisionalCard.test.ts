import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import React from "react";
import type { Opportunity, Match } from "../../lib/types";
import type { PreviewItem } from "../../lib/ui/previewReducer";
import OpportunityCard, { nextRingFading } from "../OpportunityCard";

/**
 * Instant cards — the provisional (unscored) card, and the ANALYZING ring
 * (§5) on the score badge. SSR render via renderToStaticMarkup, the same
 * technique as components/__tests__/OpportunityAlerts.test.ts.
 */

function opp(id: string): Opportunity {
  return {
    id,
    source: "grants.gov",
    kind: "grant",
    program: `Program ${id}`,
    agency: "Test Agency",
    description: `desc ${id}`,
    eligibility: "US small business.",
  };
}

function match(id: string, overrides: Partial<Match> = {}): Match {
  return {
    opportunity: opp(id),
    tier: "likely",
    score: 62,
    criteria: [],
    whyCare: "",
    whyFit: "",
    whyIneligible: "",
    whatToVerify: "",
    whatToDoNext: "",
    ...overrides,
  };
}

describe("<OpportunityCard/> — ProvisionalCard (no score yet)", () => {
  const provisional: PreviewItem = { opportunity: opp("p-1"), provisional: true };

  test("renders no percentage/number for the program", () => {
    const html = renderToStaticMarkup(React.createElement(OpportunityCard, { m: provisional, index: 0 }));
    // Rendered text content only (not CSS class names like `w-[calc(100%...)]`,
    // which legitimately contain digit+% patterns).
    const textOnly = html.replace(/<[^>]*>/g, " ");
    assert.doesNotMatch(textOnly, /\d+%/, "a provisional card must never show a fabricated score");
  });

  test("shows a neutral placeholder inside the ring, never a fake number", () => {
    const html = renderToStaticMarkup(React.createElement(OpportunityCard, { m: provisional, index: 0 }));
    assert.match(html, /&mdash;|—/);
  });

  test("has an accessible 'Analyzing, score may change' label", () => {
    const html = renderToStaticMarkup(React.createElement(OpportunityCard, { m: provisional, index: 0 }));
    assert.match(html, /aria-label="Analyzing, score may change"/);
  });

  test("renders the ANALYZING ring text, marked aria-hidden", () => {
    const html = renderToStaticMarkup(React.createElement(OpportunityCard, { m: provisional, index: 0 }));
    assert.match(html, /ANALYZING/);
    assert.match(html, /<svg[^>]*aria-hidden="true"[^>]*>[\s\S]*ANALYZING/);
  });
});

describe("<OpportunityCard/> — ANALYZING ring on a scored card", () => {
  test("final === false renders the ring around the real interim score (not a placeholder)", () => {
    const m = match("a", { final: false, score: 41 });
    const html = renderToStaticMarkup(React.createElement(OpportunityCard, { m, index: 0 }));
    assert.match(html, /ANALYZING/);
    assert.match(html, />41<|>41\s*</, );
  });

  test("final (default/true) renders no ring at all", () => {
    const m = match("a", { score: 62 });
    const html = renderToStaticMarkup(React.createElement(OpportunityCard, { m, index: 0 }));
    assert.doesNotMatch(html, /ANALYZING/);
  });

  test("the accessible label announces the real interim score, not just 'Analyzing'", () => {
    const m = match("a", { final: false, score: 41 });
    const html = renderToStaticMarkup(React.createElement(OpportunityCard, { m, index: 0 }));
    assert.match(html, /aria-label="Analyzing, 41%, score may change"/);
  });
});

describe("nextRingFading — ANALYZING ring fade-out state transition", () => {
  test("starts fading exactly when final flips from false to true/absent", () => {
    assert.equal(nextRingFading(false, true), true);
    assert.equal(nextRingFading(false, undefined), true);
  });

  test("never fades if it wasn't analyzing (final was already true/absent)", () => {
    assert.equal(nextRingFading(true, true), false);
    assert.equal(nextRingFading(undefined, true), false);
  });

  test("never fades while still analyzing (final stays false)", () => {
    assert.equal(nextRingFading(false, false), false);
  });
});

describe("<OpportunityCard/> — ANALYZING ring ids are unique per card", () => {
  test("two analyzing rings on the same page never share a path id (no duplicate DOM ids)", () => {
    const a = match("a", { final: false, score: 30 });
    const b = match("b", { final: false, score: 40 });
    const html = renderToStaticMarkup(
      React.createElement(
        React.Fragment,
        null,
        React.createElement(OpportunityCard, { m: a, index: 0 }),
        React.createElement(OpportunityCard, { m: b, index: 1 }),
      ),
    );
    const ids = Array.from(html.matchAll(/<path id="([^"]+)"/g)).map((m) => m[1]);
    assert.equal(ids.length, 2);
    assert.notEqual(ids[0], ids[1], "each AnalyzingRing must generate its own unique path id via useId");
  });
});
