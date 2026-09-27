import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { previewReducer } from "@/lib/ui/previewReducer";
import { CARD_CAP } from "@/components/OpportunityMap";
import type { Match, Opportunity } from "@/lib/types";

/**
 * previewReducer — the two-pass progressive-preview reducer (page.tsx). Two
 * regressions this proves against:
 *   (a) a re-emit of an already-shown candidate (Pass A score → Pass B
 *       narrative) updates the SAME card in place, never duplicating it;
 *   (b) once the preview is full, a HIGHER-scoring arrival evicts the
 *       LOWEST-scored card rather than being dropped — keeping the list sorted
 *       by score so it converges on the top-N the finished map will show.
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

function match(id: string, score: number, tier: Match["tier"] = "likely"): Match {
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
  };
}

describe("previewReducer", () => {
  test("a re-emit for the same opportunity id updates the card in place", () => {
    const afterScore = previewReducer([], match("opp-1", 28, "adjacent"));
    const afterNarrative = previewReducer(afterScore, match("opp-1", 65, "likely"));
    assert.equal(afterNarrative.length, 1);
    assert.equal(afterNarrative[0].tier, "likely");
    assert.equal(afterNarrative[0].score, 65);
  });

  test("a re-emit that drops to tier 'none' removes the card", () => {
    const afterScore = previewReducer([], match("opp-1", 28, "adjacent"));
    const afterDemoted = previewReducer(afterScore, match("opp-1", 5, "none"));
    assert.equal(afterDemoted.length, 0);
  });

  test("stays sorted by score descending as candidates stream in", () => {
    let prev: Match[] = [];
    for (const [id, score] of [["a", 50], ["b", 90], ["c", 70]] as const) {
      prev = previewReducer(prev, match(id, score));
    }
    assert.deepEqual(prev.map((m) => m.opportunity.id), ["b", "c", "a"]);
  });

  test("once full, a higher-scoring arrival evicts the lowest-scored card", () => {
    let prev: Match[] = [];
    for (let i = 0; i < CARD_CAP; i++) prev = previewReducer(prev, match(`low-${i}`, 30 + i));
    assert.equal(prev.length, CARD_CAP);
    const lowestScore = Math.min(...prev.map((m) => m.score));

    const withHighScorer = previewReducer(prev, match("high", 99));
    assert.equal(withHighScorer.length, CARD_CAP);
    assert.ok(withHighScorer.some((m) => m.opportunity.id === "high"));
    assert.ok(!withHighScorer.some((m) => m.score === lowestScore));
  });

  test("a 'none'-tier candidate is never added", () => {
    const prev = previewReducer([], match("opp-none", 5, "none"));
    assert.equal(prev.length, 0);
  });
});
