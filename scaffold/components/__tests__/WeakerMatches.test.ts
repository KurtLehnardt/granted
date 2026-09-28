import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import React from "react";
import type { Match, Opportunity } from "../../lib/types";
import WeakerMatches from "../WeakerMatches";

/**
 * "More matches" (§2, never-vanish list) — collapsed by default, labeled
 * "More matches (N)", renders nothing when empty, renders nothing while
 * collapsed (aria-expanded="false"). SSR render via renderToStaticMarkup, the
 * same technique as components/__tests__/OpportunityAlerts.test.ts.
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
    tier: "none",
    score: 5,
    criteria: [],
    whyCare: "",
    whyFit: "",
    whyIneligible: "",
    whatToVerify: "",
    whatToDoNext: "",
    ...overrides,
  };
}

describe("<WeakerMatches/> — collapsed 'More matches' section", () => {
  test("renders nothing when there are no matches", () => {
    const html = renderToStaticMarkup(React.createElement(WeakerMatches, { matches: [] }));
    assert.equal(html, "");
  });

  test("collapsed by default: aria-expanded=false, and no cards rendered", () => {
    const html = renderToStaticMarkup(
      React.createElement(WeakerMatches, { matches: [match("a"), match("b")] }),
    );
    assert.match(html, /aria-expanded="false"/);
    assert.doesNotMatch(html, /Program a/);
    assert.doesNotMatch(html, /Program b/);
  });

  test("label reads 'More matches (N)' with the real count", () => {
    const html = renderToStaticMarkup(
      React.createElement(WeakerMatches, { matches: [match("a"), match("b"), match("c")] }),
    );
    assert.match(html, /More matches \(3\)/);
    assert.doesNotMatch(html, /Weaker matches/);
  });

  test("an unscored candidate renders a 'Couldn't score' placeholder, never a fake number", () => {
    const html = renderToStaticMarkup(
      React.createElement(WeakerMatches, {
        matches: [match("unscored-1", { unscored: true, final: true, score: 0 })],
        defaultOpen: true,
      }),
    );
    assert.match(html, /Couldn.t score/);
    assert.doesNotMatch(html, /0%/, "an unscored candidate must never render its placeholder score as a real number");
  });

  test("a real scored match still renders its percentage, not the 'Couldn't score' placeholder", () => {
    const html = renderToStaticMarkup(
      React.createElement(WeakerMatches, {
        matches: [match("real-1", { unscored: false, tier: "adjacent", score: 28 })],
        defaultOpen: true,
      }),
    );
    assert.doesNotMatch(html, /Couldn.t score/);
    assert.match(html, />28<|>28\s*</);
  });
});
