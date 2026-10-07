import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import OpportunityMap from "../OpportunityMap";
import type { OpportunityMap as MapT } from "@/lib/types";

/** A search that fell back to keyword matching says so above the results. */

// OpportunityMap.tsx relies on Next's automatic JSX runtime; the test runner compiles it classically.
(globalThis as { React?: typeof React }).React = React;

const base: MapT = {
  profile: { description: "x" } as MapT["profile"],
  followUps: [],
  summary: { highPotential: 0, fundingIdentified: 0, agencies: 0, closingIn90Days: 0 },
  matches: [],
  agencyIntelligence: [],
};

test("a keyword-only search shows its notice", () => {
  const message = "Search is running in keyword-only mode: couldn't download the search model (fetch failed)";
  const html = renderToStaticMarkup(React.createElement(OpportunityMap, { map: { ...base, searchNotice: { kind: "keyword_only", message } } }));
  assert.match(html, /data-testid="search-notice"/);
  assert.ok(html.includes("Search is running in keyword-only mode: couldn&#x27;t download the search model (fetch failed)"));
});

test("a normal search shows none", () => {
  const html = renderToStaticMarkup(React.createElement(OpportunityMap, { map: base }));
  assert.doesNotMatch(html, /search-notice/);
});
