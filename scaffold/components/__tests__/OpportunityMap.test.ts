import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { selectShownMatches, CARD_CAP } from "../OpportunityMap";
import type { Match, Opportunity } from "@/lib/types";

/**
 * selectShownMatches — the early-eligibility-filter visibility fix. An
 * eligibility-`excluded` candidate scores 0 / tiers `none` (lib/match.ts's
 * `preExcluded` path), so the plain tier-`none` filter that hides the rest of
 * the `none` bulk would also silently hide it — the exact silent drop R8.2 and
 * C1's own "a VISIBLE `excluded`" comment forbid. It must stay visible without
 * competing with real fits for the capped card slots or inflating the header
 * stats (closingSoon/funding/expired), which read `real` only.
 */

function opp(id: string): Opportunity {
  return {
    id,
    source: "grants.gov",
    kind: "grant",
    program: `program ${id}`,
    agency: "TestAgency",
    description: `desc ${id}`,
    eligibility: "US small business.",
  };
}

function match(id: string, score: number, tier: Match["tier"], excluded = false): Match {
  return {
    opportunity: opp(id),
    tier,
    score,
    criteria: [],
    whyCare: "",
    whyFit: "",
    whyIneligible: "",
    whatToVerify: "",
    whatToDoNext: "",
    ...(excluded
      ? {
          eligibility: {
            determination: {
              opportunity_id: id,
              bucket: "excluded",
              satisfied_rules: [],
              failed_rules: [],
              unknown_rules: [],
              required_steps: [],
            },
          },
        }
      : {}),
  } as Match;
}

describe("selectShownMatches", () => {
  test("a tier-'none' excluded candidate is returned, not silently dropped", () => {
    const matches = [match("real-1", 70, "likely"), match("excluded-1", 0, "none", true)];
    const { real, excluded } = selectShownMatches(matches);
    assert.deepEqual(real.map((m) => m.opportunity.id), ["real-1"]);
    assert.deepEqual(excluded.map((m) => m.opportunity.id), ["excluded-1"]);
  });

  test("a non-excluded tier-'none' candidate moves to weaker, not real/excluded", () => {
    const matches = [match("weak-1", 5, "none", false)];
    const { real, excluded, weaker } = selectShownMatches(matches);
    assert.equal(real.length, 0);
    assert.equal(excluded.length, 0);
    assert.deepEqual(weaker.map((m) => m.opportunity.id), ["weak-1"]);
  });

  test("weaker matches are never capped and sort best-first", () => {
    const matches = [
      match("weak-lo", 2, "none", false),
      match("weak-hi", 20, "none", false),
      ...Array.from({ length: CARD_CAP + 3 }, (_, i) => match(`weak-${i}`, i, "none", false)),
    ];
    const { weaker } = selectShownMatches(matches);
    assert.equal(weaker.length, CARD_CAP + 5);
    assert.equal(weaker[0].opportunity.id, "weak-hi");
  });

  test("excluded candidates never displace a real fit from the capped card list", () => {
    const reals = Array.from({ length: CARD_CAP + 2 }, (_, i) => match(`real-${i}`, 100 - i, "likely"));
    const matches = [...reals, match("excluded-1", 0, "none", true)];
    const { real, excluded } = selectShownMatches(matches);
    assert.equal(real.length, CARD_CAP);
    assert.equal(excluded.length, 1);
  });
});
