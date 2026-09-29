import { test } from "node:test";
import assert from "node:assert/strict";
import { screen } from "../screen";
import { toScreenableOpportunity } from "../bridge";
import {
  annotateFreshness,
  type FreshnessResult,
  type CurrentSnapshotResult,
} from "../freshness";
import type { CompanyProfile } from "../../contracts/companyProfile";
import type { Opportunity } from "../../contracts/opportunity";
import type { Provenance } from "../../contracts/primitives";

/**
 * ELG-01 x ELG-02 composition — the "broaden false-exclusion coverage" gap
 * this file actually fills: the genuinely-skipped golden entries (STTR
 * partnering, Direct-to-Phase-II) need NEW predicates screen() doesn't have —
 * out of scope for a test-only pass. The FEASIBLE fallback covered here is
 * the closed-solicitation / freshness case: `screen()` has no notion of
 * "open" vs. "closed" at all (it is a pure eligibility engine), so a closed
 * solicitation can screen as `eligible` on the facts alone — it is
 * `annotateFreshness` (ELG-02), composed on top, that is responsible for
 * flagging a closed/unverifiable opportunity so it is never presented as
 * actionable. These tests exercise that composition end to end, hermetically
 * (fixtures only — no network, no DB).
 */

// ---------------------------------------------------------------------------
// Fixture helpers (mirrors lib/eligibility/__tests__/screen.test.ts and
// lib/eligibility/__tests__/freshness.test.ts)
// ---------------------------------------------------------------------------

function pf<T>(value: T, provenance: Provenance = "user_stated", confidence = 1) {
  return { value, provenance, confidence };
}

function profile(overrides: Partial<CompanyProfile> = {}): CompanyProfile {
  return {
    id: "profile-closed-solicitation",
    raw_text: pf("We build software.", "user_stated"),
    interview_answers: [],
    ...overrides,
  };
}

/** A minimal, valid v1-shaped Opportunity — bridged via ELG-04's toScreenableOpportunity. */
const CANON_OPP: Opportunity = {
  id: "grants-360339",
  source: "grants.gov",
  kind: "grant",
  program: "Test Closed Program",
  agency: "Test Agency",
  description: "A test opportunity used to exercise the closed-solicitation composition.",
  title: "Test Closed Program",
};

/** A CAN-06 corpus snapshot whose data is `hours` old (fresh by default). */
function snapshot(hours: number, over: Partial<CurrentSnapshotResult> = {}): CurrentSnapshotResult {
  const ms = Math.round(hours * 3_600_000);
  return {
    version: "canon-2026-08-15",
    data_age: { ms, hours, human: `${hours} hours` },
    retrieved_at: "2026-08-15T09:00:00.000Z",
    source_coverage: { alarms: [] },
    ...over,
  };
}

function closedFreshness(over: Partial<FreshnessResult> = {}): FreshnessResult {
  return {
    id: "grants-360339",
    source: "grants.gov",
    status: "closed",
    close_date: "2026-08-01T00:00:00.000Z",
    days_remaining: -14,
    checked_at: "2026-08-15T12:00:00.000Z",
    cache: "miss",
    ...over,
  };
}

function openFreshness(over: Partial<FreshnessResult> = {}): FreshnessResult {
  return {
    id: "grants-360339",
    source: "grants.gov",
    status: "open",
    close_date: "2026-12-31T23:59:59.000Z",
    days_remaining: 138,
    checked_at: "2026-08-15T12:00:00.000Z",
    cache: "miss",
    ...over,
  };
}

// ---------------------------------------------------------------------------
// The composition
// ---------------------------------------------------------------------------

test("closed solicitation: screen() alone is oblivious (eligible on the facts), but annotateFreshness surfaces is_stale=true with a caveat naming the closure", () => {
  const opp = toScreenableOpportunity(CANON_OPP);
  const det = screen(
    profile({
      entity_type: pf("for_profit_small_business", "user_stated"),
      sam_registered: pf(true, "user_stated"),
    }),
    opp,
    [], // no per-opp rules, no SBIR overlay (non-SBIR title/program)
  );
  // screen() has no open/closed concept: a clean profile against a rule-free,
  // registered-and-satisfied opportunity is `eligible` on the facts alone.
  assert.equal(det.bucket, "eligible");

  const withFreshness = annotateFreshness(det, {
    snapshot: snapshot(2), // fresh corpus — isolates the OPPORTUNITY-level closure signal
    freshness: closedFreshness(),
  });

  assert.equal(withFreshness.freshness.is_stale, true);
  assert.ok(
    withFreshness.freshness.caveat && withFreshness.freshness.caveat.length > 0,
    "a stale/closed result must carry a non-empty caveat",
  );
  assert.match(withFreshness.freshness.caveat!, /closed/i);
  // The underlying determination is returned unchanged — its bucket is still
  // `eligible`; the caveat is what prevents the caller from presenting this
  // as actionable, not a mutation of the determination itself.
  assert.equal(withFreshness.determination, det);
  assert.equal(withFreshness.determination.bucket, "eligible");
});

test("fresh corpus + verified live-open opportunity -> is_stale false, no caveat", () => {
  const opp = toScreenableOpportunity(CANON_OPP);
  const det = screen(profile({ sam_registered: pf(true, "user_stated") }), opp, []);

  const withFreshness = annotateFreshness(det, {
    snapshot: snapshot(2),
    freshness: openFreshness(),
  });

  assert.equal(withFreshness.freshness.is_stale, false);
  assert.equal(withFreshness.freshness.caveat, null);
});

test("live status could not be re-verified (freshness_unavailable) -> is_stale true with a caveat naming the unverifiability, never asserted as current", () => {
  const opp = toScreenableOpportunity(CANON_OPP);
  const det = screen(profile({ sam_registered: pf(true, "user_stated") }), opp, []);

  const unavailable: FreshnessResult = {
    id: "grants-360339",
    source: "grants.gov",
    status: null,
    checked_at: "2026-08-15T12:00:00.000Z",
    cache: "miss",
    freshness_unavailable: true,
    reason: "grants.gov circuit breaker open",
  };

  const withFreshness = annotateFreshness(det, {
    snapshot: snapshot(2),
    freshness: unavailable,
  });

  assert.equal(withFreshness.freshness.is_stale, true);
  assert.ok(withFreshness.freshness.caveat && withFreshness.freshness.caveat.length > 0);
  assert.match(withFreshness.freshness.caveat!, /not.*re-verified|could not be re-verified/i);
});
