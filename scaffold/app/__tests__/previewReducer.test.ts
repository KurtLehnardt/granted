import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { previewReducer, partitionPreview, isProvisional, type PreviewItem } from "@/lib/ui/previewReducer";
import { CARD_CAP } from "@/components/OpportunityMap";
import type { Match, Opportunity } from "@/lib/types";

/**
 * previewReducer — the instant-cards progressive-preview reducer (page.tsx).
 *
 * Cards stream in three shapes: a provisional (unscored) retrieval hit, a
 * Pass-A score, and a Pass-B narrative — all keyed by opportunity id. The
 * reducer's job is purely to upsert the LATEST data for an id IN PLACE,
 * without moving its position (so cards don't jump around while streaming),
 * and to never drop anything (a weak final score moves to the "weaker
 * matches" section via `partitionPreview`, it isn't removed).
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

function provisional(id: string): PreviewItem {
  return { opportunity: opp(id), provisional: true };
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
  test("provisional hits are appended in retrieval order", () => {
    let prev: PreviewItem[] = [];
    for (const id of ["a", "b", "c"]) prev = previewReducer(prev, provisional(id));
    assert.deepEqual(prev.map((p) => p.opportunity.id), ["a", "b", "c"]);
    assert.ok(prev.every(isProvisional));
  });

  test("a score for an already-provisional id updates it in place, without moving it", () => {
    let prev: PreviewItem[] = [];
    for (const id of ["a", "b", "c"]) prev = previewReducer(prev, provisional(id));
    prev = previewReducer(prev, match("b", 65, "likely"));

    assert.deepEqual(prev.map((p) => p.opportunity.id), ["a", "b", "c"]);
    assert.equal(isProvisional(prev[1]), false);
    assert.equal((prev[1] as Match).score, 65);
  });

  test("a Pass-B re-emit for the same id updates the card in place, still without reordering", () => {
    let prev: PreviewItem[] = previewReducer([], match("opp-1", 28, "adjacent"));
    prev = previewReducer(prev, match("opp-1", 65, "likely"));
    assert.equal(prev.length, 1);
    assert.equal((prev[0] as Match).tier, "likely");
    assert.equal((prev[0] as Match).score, 65);
  });

  test("streaming never re-sorts: arrival order is preserved regardless of score", () => {
    let prev: PreviewItem[] = [];
    for (const [id, score] of [["a", 50], ["b", 90], ["c", 70]] as const) {
      prev = previewReducer(prev, match(id, score));
    }
    assert.deepEqual(prev.map((p) => p.opportunity.id), ["a", "b", "c"]);
  });

  test("a stale provisional arriving after a real score never overwrites it", () => {
    let prev: PreviewItem[] = previewReducer([], match("opp-1", 70, "likely"));
    prev = previewReducer(prev, provisional("opp-1"));
    assert.equal(isProvisional(prev[0]), false);
    assert.equal((prev[0] as Match).score, 70);
  });

  test("a 'none'-tier final score is kept, not dropped", () => {
    const prev = previewReducer([], match("opp-none", 5, "none"));
    assert.equal(prev.length, 1);
    assert.equal((prev[0] as Match).tier, "none");
  });

  test("a re-emit that drops to tier 'none' still keeps the card (moves to weaker via partitionPreview, never vanishes)", () => {
    let prev: PreviewItem[] = previewReducer([], match("opp-1", 28, "adjacent"));
    prev = previewReducer(prev, match("opp-1", 5, "none"));
    assert.equal(prev.length, 1);
    assert.equal((prev[0] as Match).tier, "none");
  });
});

describe("partitionPreview", () => {
  test("provisional and non-'none' matches are shown; a final tier-'none' match is set aside as weaker", () => {
    const items: PreviewItem[] = [provisional("prov-1"), match("real-1", 70, "likely"), match("weak-1", 5, "none")];
    const { shown, weaker } = partitionPreview(items, CARD_CAP);
    assert.deepEqual(shown.map((p) => p.opportunity.id), ["prov-1", "real-1"]);
    assert.deepEqual(weaker.map((p) => p.opportunity.id), ["weak-1"]);
  });

  test("shown is capped at CARD_CAP; everything past the cap — real matches included, §2 — moves to 'more matches', never dropped", () => {
    const reals = Array.from({ length: CARD_CAP + 2 }, (_, i) => match(`real-${i}`, 90 - i, "likely"));
    const weaks = Array.from({ length: 5 }, (_, i) => match(`weak-${i}`, 5, "none"));
    const { shown, weaker } = partitionPreview([...reals, ...weaks], CARD_CAP);
    assert.equal(shown.length, CARD_CAP);
    // The top CARD_CAP reals by score are shown; the last 2 reals (past the
    // cap) plus the 5 tier-"none" weaks all land in "more matches" — none
    // silently dropped.
    assert.equal(weaker.length, 7);
    assert.deepEqual(
      shown.map((p) => p.opportunity.id),
      reals.slice(0, CARD_CAP).map((m) => m.opportunity.id),
    );
  });

  test("an unscored candidate is never shown as a real card — always in 'more matches'", () => {
    const items: PreviewItem[] = [
      match("real-1", 70, "likely"),
      { ...match("unscored-1", 0, "none"), unscored: true },
    ];
    const { shown, weaker } = partitionPreview(items, CARD_CAP);
    assert.deepEqual(shown.map((p) => p.opportunity.id), ["real-1"]);
    assert.deepEqual(weaker.map((p) => p.opportunity.id), ["unscored-1"]);
  });
});
