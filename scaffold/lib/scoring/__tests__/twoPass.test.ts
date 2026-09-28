import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  PROMOTION_FLOOR,
  promotedIds,
  scoreOnlyAssessment,
  assembleTwoPass,
  type Assessment,
  type PassAScore,
} from "../twoPass";
import { tierFromScore } from "../../match";

/**
 * E3 — pure unit tests for the two-pass merge core (no SDK, no network).
 *
 * These pin the load-bearing invariants of `assembleTwoPass`: promoted
 * candidates carry the full Pass-B narrative, non-promoted keep only their
 * Pass-A score, nothing is fabricated or silently dropped, and — the sacred one
 * — the TIER a candidate lands in is identical to the tier its single-pass score
 * would produce, for a fixed scoring set.
 */

function full(id: string, score: number): Assessment {
  return {
    id,
    score,
    tier: "likely",
    criteria: [{ label: "US small business", met: true, note: "" }],
    whyCare: `care ${id}`,
    whyFit: `fit ${id}`,
    whyIneligible: `verify ${id}`,
    whatToVerify: `check ${id}`,
    whatToDoNext: `next ${id}`,
  };
}

describe("E3 twoPass — promotion", () => {
  test("PROMOTION_FLOOR is the adjacent boundary (25) — the lowest rendering tier", () => {
    assert.equal(PROMOTION_FLOOR, 25);
    // Everything at/above the floor renders as a real tier; below it is `none`.
    assert.notEqual(tierFromScore(PROMOTION_FLOOR), "none");
    assert.equal(tierFromScore(PROMOTION_FLOOR - 1), "none");
  });

  test("promotedIds selects ids at/above the floor, drops those below (and non-finite)", () => {
    const passA: PassAScore[] = [
      { id: "a", score: 60 },
      { id: "b", score: 25 }, // exactly the floor → promoted
      { id: "c", score: 24 }, // below → not promoted
      { id: "d", score: Number.NaN }, // malformed → not promoted
    ];
    const promoted = promotedIds(passA);
    assert.deepEqual(Array.from(promoted).sort(), ["a", "b"]);
  });
});

describe("E3 twoPass — assembleTwoPass", () => {
  const passA: PassAScore[] = [
    { id: "likely", score: 72 },
    { id: "verify", score: 40 },
    { id: "adjacent", score: 28 },
    { id: "none", score: 15 },
  ];
  const order = ["likely", "verify", "adjacent", "none"];

  test("promoted candidates carry the full Pass-B assessment; non-promoted are score-only", () => {
    const promoted = passA.filter((s) => s.score >= PROMOTION_FLOOR).map((s) => full(s.id, s.score));
    const merged = assembleTwoPass(order, passA, promoted);

    const byId = new Map(merged.map((m) => [m.id, m]));
    // promoted (>=25) keep the narrative
    assert.equal(byId.get("likely")!.whyFit, "fit likely");
    assert.equal(byId.get("adjacent")!.whyFit, "fit adjacent");
    // non-promoted (<25) are score-only: empty narrative, score preserved
    assert.equal(byId.get("none")!.whyFit, "");
    assert.equal(byId.get("none")!.whyCare, "");
    assert.equal(byId.get("none")!.criteria.length, 0);
    assert.equal(byId.get("none")!.score, 15);
    // output is in candidate order, every candidate present
    assert.deepEqual(merged.map((m) => m.id), order);
  });

  test("SACRED: flag-on tiers equal single-pass tiers for a fixed scoring set", () => {
    // Baseline = what the single pass would return: full assessments for all.
    const baseline = passA.map((s) => full(s.id, s.score));
    // Two-pass = Pass-A scores + Pass-B narratives for the promoted only.
    const promoted = passA.filter((s) => s.score >= PROMOTION_FLOOR).map((s) => full(s.id, s.score));
    const merged = assembleTwoPass(order, passA, promoted);

    const tierOf = (rows: Assessment[]) =>
      new Map(rows.map((r) => [r.id, tierFromScore(r.score)]));
    // The tier every candidate lands in must be identical between the two paths.
    assert.deepEqual(tierOf(merged), tierOf(baseline));
    // And it spans all four bands, so this isn't a vacuous check.
    assert.deepEqual(
      order.map((id) => tierFromScore(merged.find((m) => m.id === id)!.score)),
      ["likely", "verify", "adjacent", "none"],
    );
  });

  test("a promoted candidate whose Pass-B is missing degrades to score-only (never dropped)", () => {
    // 'likely' is promoted but Pass B returned nothing for it (batch failed).
    const merged = assembleTwoPass(order, passA, [full("verify", 40), full("adjacent", 28)]);
    const likely = merged.find((m) => m.id === "likely")!;
    assert.equal(likely.score, 72, "keeps its Pass-A score");
    assert.equal(likely.whyFit, "", "degrades to score-only narrative");
    assert.equal(tierFromScore(likely.score), "likely", "still tiers correctly from the score");
  });

  test("a candidate with no Pass-A score is never dropped (§1) — an explicit unscored, final placeholder instead", () => {
    const merged = assembleTwoPass(["likely", "ghost"], [{ id: "likely", score: 72 }], []);
    assert.deepEqual(merged.map((m) => m.id), ["likely", "ghost"]);
    const ghost = merged.find((m) => m.id === "ghost")!;
    assert.equal(ghost.unscored, true);
    assert.equal(ghost.final, true);
    assert.equal(ghost.score, 0);
  });

  test("every assessment out of assembleTwoPass is final (it's the terminal merge)", () => {
    const merged = assembleTwoPass(order, passA, [full("likely", 72)]);
    assert.ok(merged.every((m) => m.final === true));
  });

  test("scoreOnlyAssessment is a well-formed, narrative-empty, `none`-tier row", () => {
    const a = scoreOnlyAssessment("x", 10);
    assert.equal(a.score, 10);
    assert.equal(a.tier, "none");
    assert.deepEqual(a.criteria, []);
    assert.equal(a.whyCare + a.whyFit + a.whyIneligible + a.whatToVerify + a.whatToDoNext, "");
  });
});
