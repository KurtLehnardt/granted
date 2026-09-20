import { test } from "node:test";
import assert from "node:assert/strict";
import { reconcileIneligibilityNarrative } from "../../claude";
import type { EligibilityBucket } from "../../contracts/eligibilityDetermination";

/**
 * ONE ELIGIBILITY VOICE (§1 #5 / R8.4). The deterministic
 * `EligibilityDetermination` from lib/eligibility/screen.ts is the SOURCE OF
 * TRUTH. The model `whyIneligible` narrative is subordinate to it and may NEVER
 * assert a determination the engine didn't make.
 *
 * These tests feed a deliberate MISMATCH — a narrative that boldly asserts the
 * user is ineligible while the engine did NOT exclude — and prove the
 * assertion is reconciled/blocked. Importing `reconcileIneligibilityNarrative`
 * from lib/claude.ts is the point: the constraint lives with the narrative it
 * governs. (Pure function — no API key or network is touched.)
 */

const det = (bucket: EligibilityBucket) => ({ bucket });

/** A local, independent detector for a bald (non-hedged) exclusion assertion. */
const DEFINITIVE =
  /\b(?:you(?:'re| are)\s+(?:ineligible|not eligible|excluded|disqualified|barred)|you\s+do(?:es)?\s+not\s+qualify|you\s+don'?t\s+qualify|your\s+company\s+is\s+(?:ineligible|not eligible|excluded))\b/i;

const OVERASSERTION =
  "You are ineligible for this program because your company is not majority U.S.-owned. You do not qualify.";

test("MISMATCH: engine did NOT exclude (eligible) but narrative asserts ineligibility → reconciled/blocked", () => {
  const out = reconcileIneligibilityNarrative(OVERASSERTION, det("eligible"));
  assert.equal(out.reconciled, true, "the over-assertion must be flagged as reconciled");
  assert.ok(!DEFINITIVE.test(out.text), "the reconciled narrative must not assert a definitive exclusion");
  assert.notEqual(out.text, OVERASSERTION, "the raw over-assertion must not survive verbatim");
});

test("MISMATCH: conditionally_eligible + a definitive exclusion assertion → reconciled/blocked", () => {
  const out = reconcileIneligibilityNarrative(OVERASSERTION, det("conditionally_eligible"));
  assert.equal(out.reconciled, true);
  assert.ok(!DEFINITIVE.test(out.text));
});

test("MISMATCH: unknown + a definitive exclusion assertion → reconciled/blocked", () => {
  const out = reconcileIneligibilityNarrative(OVERASSERTION, det("unknown"));
  assert.equal(out.reconciled, true);
  assert.ok(!DEFINITIVE.test(out.text));
});

test("MISMATCH: no determination attached at all → still neutralizes a bald exclusion claim", () => {
  const out = reconcileIneligibilityNarrative(OVERASSERTION, undefined);
  assert.equal(out.reconciled, true);
  assert.ok(!DEFINITIVE.test(out.text));
});

test("ALIGNED: engine bucket IS excluded → the narrative may state it (passed through, not reconciled)", () => {
  const out = reconcileIneligibilityNarrative(OVERASSERTION, det("excluded"));
  assert.equal(out.reconciled, false, "the engine made this determination — the narrative may echo it");
  assert.equal(out.text, OVERASSERTION);
});

test("ALLOWED: an already-hedged narrative is the subordinate voice → passes through unchanged", () => {
  const hedged =
    "You may not qualify unless you complete SAM.gov registration; verify size standards with the program officer.";
  const out = reconcileIneligibilityNarrative(hedged, det("conditionally_eligible"));
  assert.equal(out.reconciled, false);
  assert.equal(out.text, hedged);
});

test("empty / missing narrative is a no-op (never fabricates an assertion)", () => {
  assert.deepEqual(reconcileIneligibilityNarrative("", det("eligible")), { text: "", reconciled: false });
  assert.deepEqual(reconcileIneligibilityNarrative(undefined, det("eligible")), { text: "", reconciled: false });
});

test("softened output keeps the specific concern but drops the determination", () => {
  const out = reconcileIneligibilityNarrative(
    "You are not eligible because you are foreign-owned.",
    det("unknown"),
  );
  assert.equal(out.reconciled, true);
  assert.ok(!DEFINITIVE.test(out.text));
  // The substantive concern (foreign ownership) is preserved where possible.
  assert.match(out.text, /foreign-owned/i);
});
