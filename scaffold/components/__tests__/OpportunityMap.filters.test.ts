import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import OpportunityMap from "../OpportunityMap";
import type { Match, OpportunityMap as MapT } from "@/lib/types";

/**
 * Sort and filter show on the results by default. The `match_filters` flag
 * defaulted off, so a user who merged the feature never saw it (nothing sets
 * NEXT_PUBLIC_FLAG_MATCH_FILTERS); it's now an off switch only.
 */

// OpportunityMap.tsx relies on Next's automatic JSX runtime; the test runner compiles it classically.
(globalThis as { React?: typeof React }).React = React;

function match(id: string, score: number): Match {
  return {
    opportunity: {
      id,
      source: "grants.gov",
      kind: "grant",
      program: `program ${id}`,
      agency: "TestAgency",
      description: `desc ${id}`,
      eligibility: "US small business.",
      url: `https://www.grants.gov/${id}`,
    },
    tier: "likely",
    score,
    criteria: [],
    whyCare: "",
    whyFit: "",
    whyIneligible: "",
    whatToVerify: "",
    whatToDoNext: "",
  } as Match;
}

const map: MapT = {
  profile: { description: "x" } as MapT["profile"],
  followUps: [],
  summary: { highPotential: 2, fundingIdentified: 0, agencies: 1, closingIn90Days: 0 },
  matches: [match("a", 80), match("b", 60)],
  agencyIntelligence: [],
};

const saved = process.env.NEXT_PUBLIC_FLAG_MATCH_FILTERS;
afterEach(() => {
  if (saved === undefined) delete process.env.NEXT_PUBLIC_FLAG_MATCH_FILTERS;
  else process.env.NEXT_PUBLIC_FLAG_MATCH_FILTERS = saved;
});

test("REGRESSION (user): sort shows on the results with no flag set at all", () => {
  delete process.env.NEXT_PUBLIC_FLAG_MATCH_FILTERS;
  const html = renderToStaticMarkup(React.createElement(OpportunityMap, { map }));
  assert.match(html, /Sort by/);
});

test("NEXT_PUBLIC_FLAG_MATCH_FILTERS=false still turns it off", () => {
  process.env.NEXT_PUBLIC_FLAG_MATCH_FILTERS = "false";
  const html = renderToStaticMarkup(React.createElement(OpportunityMap, { map }));
  assert.doesNotMatch(html, /Sort by/);
  assert.match(html, /program a/, "the results still render");
});
