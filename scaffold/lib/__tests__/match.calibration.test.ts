import { test } from "node:test";
import assert from "node:assert/strict";

import { tierFromScore, historyFor, CALIBRATION, clampCandidateCount } from "../match";

/**
 * Pure calibration helpers of the match pipeline (H6). No LLM / embedding /
 * network — these are exact-boundary unit tests of the tier thresholds and the
 * award-history lookup's missing-id behavior.
 */

test("tierFromScore — exact boundaries around the calibrated thresholds", () => {
  // scoreFloor is the verify/adjacent boundary; keep the test honest if it moves.
  // E1: raised 30 -> 33 so case-5's education/STEM GRANT noise (~<=32) cannot
  // over-match as "strong" — protecting the sacred honest-no.
  assert.equal(CALIBRATION.scoreFloor, 33);

  assert.equal(tierFromScore(100), "likely");
  assert.equal(tierFromScore(60), "likely"); // >= 60 (E1: lowered from 75 — a dead tier on the 968-opp corpus, whose score ceiling is ~78)
  assert.equal(tierFromScore(59), "verify");
  assert.equal(tierFromScore(33), "verify"); // >= scoreFloor
  assert.equal(tierFromScore(32), "adjacent"); // case-5's grant spikes land here (permitted adjacent)
  assert.equal(tierFromScore(25), "adjacent"); // >= 25
  assert.equal(tierFromScore(24), "none");
  assert.equal(tierFromScore(0), "none");
});

test("historyFor — an opportunity id with no award rows returns undefined (never throws)", () => {
  assert.equal(historyFor("this-id-has-no-award-rows-xyz"), undefined);
  assert.equal(historyFor("this-id-has-no-award-rows-xyz", "utah"), undefined);
});

test("clampCandidateCount — user 'search depth' is clamped to a safe range", () => {
  const def = CALIBRATION.candidateCount;
  // Absent / invalid → the calibrated default.
  assert.equal(clampCandidateCount(undefined), def);
  assert.equal(clampCandidateCount(null), def);
  assert.equal(clampCandidateCount(NaN), def);
  // Lowering is honored (the whole point — faster local searches).
  assert.equal(clampCandidateCount(12), 12);
  assert.equal(clampCandidateCount(6), 6);
  // Floored at 4 so a run still returns something; capped at the default so a
  // client value can never overrun the scorer's token budget.
  assert.equal(clampCandidateCount(1), 4);
  assert.equal(clampCandidateCount(0), 4);
  assert.equal(clampCandidateCount(1000), def);
  // Fractional values floor to an integer count.
  assert.equal(clampCandidateCount(12.9), 12);
});
