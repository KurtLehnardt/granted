import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import React from "react";
import OpportunityFilters, { resolveEffectiveLocation } from "../OpportunityFilters";
import type { Match, Opportunity } from "@/lib/types";

function opp(id: string, geography?: string): Opportunity {
  return {
    id,
    source: geography ? "ca-grants" : "grants.gov",
    kind: "grant",
    program: `program ${id}`,
    agency: "TestAgency",
    description: `desc ${id}`,
    eligibility: "US small business.",
    ...(geography ? { geography } : {}),
  };
}

function match(id: string, geography?: string): Match {
  return {
    opportunity: opp(id, geography),
    tier: "likely",
    score: 80,
    criteria: [],
    whyCare: "",
    whyFit: "",
    whyIneligible: "",
    whatToVerify: "",
    whatToDoNext: "",
  };
}

describe("resolveEffectiveLocation", () => {
  test("null selection (\"Any location\") always resolves to null", () => {
    assert.equal(resolveEffectiveLocation(null, ["California", "Illinois"]), null);
  });

  test("a selected location still present in the available list is kept", () => {
    assert.equal(resolveEffectiveLocation("Illinois", ["California", "Illinois", "North Carolina"]), "Illinois");
  });

  test("a selected location no longer in the available list falls back to null, not a stale filter", () => {
    // Mirrors the real scenario this guards: the user picks a state, then a
    // new search's matches no longer include it (different company profile).
    assert.equal(resolveEffectiveLocation("Illinois", ["California", "North Carolina"]), null);
  });

  test("an empty available list always falls back to null", () => {
    assert.equal(resolveEffectiveLocation("California", []), null);
  });
});

describe("OpportunityFilters render", () => {
  // REGRESSION (found live): Sort used to be nested inside the same
  // `locations.length > 0` gate as Location, so an all-federal result set
  // (no match carries a `geography`) hid Sort too, even though it has
  // nothing to do with location and is useful on any result set.
  test("Sort renders even when no match has a geography (all-federal results)", () => {
    const html = renderToStaticMarkup(
      React.createElement(OpportunityFilters, { matches: [match("a"), match("b")] }),
    );
    assert.match(html, /Sort by/);
    assert.match(html, /Match %/);
    assert.doesNotMatch(html, />Location</);
  });

  test("Location renders too once at least one match carries a geography", () => {
    const html = renderToStaticMarkup(
      React.createElement(OpportunityFilters, { matches: [match("a", "California"), match("b")] }),
    );
    assert.match(html, /Sort by/);
    assert.match(html, />Location</);
    assert.match(html, /California/);
  });

  test("a single match still shows Sort (not just >1)", () => {
    const html = renderToStaticMarkup(React.createElement(OpportunityFilters, { matches: [match("a")] }));
    assert.match(html, /Sort by/);
  });

  test("no matches at all renders nothing", () => {
    assert.equal(renderToStaticMarkup(React.createElement(OpportunityFilters, { matches: [] })), "");
  });
});
