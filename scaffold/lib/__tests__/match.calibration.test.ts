import { test } from "node:test";
import assert from "node:assert/strict";

import { tierFromScore, historyFor, historyForAgency, CALIBRATION, clampCandidateCount } from "../match";

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

test("historyFor — an opportunity id with no award rows and no fallback agency data returns undefined (never throws)", () => {
  assert.equal(historyFor("this-id-has-no-award-rows-xyz", undefined), undefined);
  assert.equal(historyFor("this-id-has-no-award-rows-xyz", "Not A Real Federal Agency"), undefined);
  assert.equal(historyFor("this-id-has-no-award-rows-xyz", "Not A Real Federal Agency", "utah"), undefined);
});

/**
 * Real-data integration checks for the agency-level fallback, against the
 * actual committed data/awards.json (NASA has real verified award rows in
 * it, cross-checked once here so this doesn't silently rot if the corpus is
 * ever regenerated without NASA data — see the skip guard below).
 */
const REAL_AGENCY_WITH_DATA = "National Aeronautics and Space Administration";

test("historyForAgency — a real agency with verified rows elsewhere returns deduped, sourceUrl-verified companies", (t) => {
  const history = historyForAgency(REAL_AGENCY_WITH_DATA);
  if (!history) {
    t.skip(`no verified rows for "${REAL_AGENCY_WITH_DATA}" in the current data/awards.json — corpus may have changed`);
    return;
  }
  assert.equal(history.fromAgency, true);
  assert.ok(history.recipients.length > 0);
  assert.ok(history.recipients.every((r) => typeof r.sourceUrl === "string" && r.sourceUrl.length > 0));
  // Deduped: no company appears twice even though it may have won awards
  // under more than one opportunity in the corpus.
  const companies = history.recipients.map((r) => r.company);
  assert.equal(new Set(companies).size, companies.length);
});

test("historyFor — falls back to the agency when this exact opportunity id has no direct rows", (t) => {
  const direct = historyForAgency(REAL_AGENCY_WITH_DATA);
  if (!direct) {
    t.skip(`no verified rows for "${REAL_AGENCY_WITH_DATA}" — see the previous test`);
    return;
  }
  const viaFallback = historyFor("definitely-not-a-real-opportunity-id-xyz", REAL_AGENCY_WITH_DATA);
  assert.ok(viaFallback);
  assert.equal(viaFallback!.fromAgency, true);
  assert.deepEqual(viaFallback, direct);
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
