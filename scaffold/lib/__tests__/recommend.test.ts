import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  recommendFor,
  mapVerdict,
  criteriaMetRatio,
  RECOMMEND_FLOOR,
  DO_NOT_RECOMMEND_BELOW,
} from "../recommend";
import type { CriterionCheck } from "../contracts/opportunityMap";

// Build a criteria array with `n` met of `total` (labels are irrelevant here).
function crit(met: number, total: number): CriterionCheck[] {
  return Array.from({ length: total }, (_, i) => ({ label: `c${i}`, met: i < met }));
}

describe("criteriaMetRatio", () => {
  test("empty → 0 (conservative)", () => {
    assert.equal(criteriaMetRatio([]), 0);
  });
  test("counts met / total", () => {
    assert.equal(criteriaMetRatio(crit(3, 5)), 0.6);
  });
});

describe("recommendFor — aggressive thresholds", () => {
  test("strong grant (≥52 + ≥60% criteria) → recommend", () => {
    const r = recommendFor({ adjustedScore: 62, kind: "grant", criteria: crit(4, 5) });
    assert.equal(r.recommendation, "recommend");
    assert.match(r.label, /worth pursuing/i);
  });

  test("real-but-partial grant (40–59) → verify", () => {
    const r = recommendFor({ adjustedScore: 48, kind: "grant", criteria: crit(3, 5) });
    assert.equal(r.recommendation, "verify");
    assert.match(r.label, /verify/i);
  });

  test("below the aggressive fit floor (score 38) → do_not_recommend (the ADV4 case)", () => {
    // A 70%-foreign-owned drone co's DoD R&D topic scored 38 under the old floor
    // of 33 and rendered as 'verify'. With the aggressive floor of 40 it is now an
    // honest 'don't apply' from score alone — before any stated-disqualifier logic.
    assert.ok(DO_NOT_RECOMMEND_BELOW === 40);
    const r = recommendFor({ adjustedScore: 38, kind: "rd", criteria: crit(3, 5) });
    assert.equal(r.recommendation, "do_not_recommend");
    assert.match(r.label, /don't recommend applying/i);
  });

  test("high score but few criteria met (<40%) → do_not_recommend", () => {
    const r = recommendFor({ adjustedScore: 70, kind: "grant", criteria: crit(1, 5) });
    assert.equal(r.recommendation, "do_not_recommend");
    assert.match(r.basis, /1 of 5/);
  });

  test("strong score + weak-ish criteria (40–59%) → verify, not recommend", () => {
    // 2/5 = 40% clears the do-not floor but is below the 60% recommend gate.
    const r = recommendFor({ adjustedScore: 65, kind: "grant", criteria: crit(2, 5) });
    assert.equal(r.recommendation, "verify");
  });

  test("user-STATED disqualifier → do_not_recommend regardless of score", () => {
    const r = recommendFor({ adjustedScore: 80, kind: "rd", criteria: crit(5, 5), statedDisqualifier: true });
    assert.equal(r.recommendation, "do_not_recommend");
    assert.match(r.basis, /confirm.*program officer/i);
  });
});

describe("per-type floors — non-grants held higher", () => {
  test("loan @62 with strong criteria → verify (below the 66 loan floor)", () => {
    assert.equal(RECOMMEND_FLOOR.loan, 66);
    const r = recommendFor({ adjustedScore: 62, kind: "loan", criteria: crit(5, 5) });
    assert.equal(r.recommendation, "verify");
  });
  test("grant @62 with the same strong criteria → recommend (grant floor 52)", () => {
    assert.equal(RECOMMEND_FLOOR.grant, 52);
    const r = recommendFor({ adjustedScore: 62, kind: "grant", criteria: crit(5, 5) });
    assert.equal(r.recommendation, "recommend");
  });
  test("scholarship @65 strong criteria → verify (floor 66)", () => {
    const r = recommendFor({ adjustedScore: 65, kind: "scholarship", criteria: crit(5, 5) });
    assert.equal(r.recommendation, "verify");
  });
});

describe("mapVerdict", () => {
  test("≥1 recommend → strong_map", () => {
    assert.equal(mapVerdict({ recommendCount: 2, verifyCount: 3, maxScore: 70 }), "strong_map");
  });
  test("0 recommend but ≥1 verify → thin_map", () => {
    assert.equal(mapVerdict({ recommendCount: 0, verifyCount: 2, maxScore: 48 }), "thin_map");
  });
  test("0 recommend, 0 verify, but a best score ≥40 → thin_map (our best is a stretch)", () => {
    assert.equal(mapVerdict({ recommendCount: 0, verifyCount: 0, maxScore: 44 }), "thin_map");
  });
  test("0 recommend, 0 verify, best score <40 → no_fit (the honest-no)", () => {
    assert.equal(mapVerdict({ recommendCount: 0, verifyCount: 0, maxScore: 30 }), "no_fit");
  });
});
