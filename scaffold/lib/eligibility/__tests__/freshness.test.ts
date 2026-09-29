import { test } from "node:test";
import assert from "node:assert/strict";
import {
  annotateFreshness,
  type EligibilityDeterminationWithFreshness,
  type CurrentSnapshotResult,
  type SyncHealthResult,
  type FreshnessResult,
} from "../freshness";
import type { EligibilityDetermination } from "../../contracts/eligibilityDetermination";

/**
 * ELG-02 unit tests — the pure data-freshness annotator (§4.5 / CAN-05 / CAN-06,
 * anti-fabrication §11). Fixtures only: `CurrentSnapshotResult` /
 * `SyncHealthResult` / `FreshnessResult` objects are built by hand — no DB, no
 * network, no LLM. `now` is injected for determinism.
 */

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

const NOW = new Date("2026-08-15T12:00:00.000Z");

/** A minimal, valid CON-01 determination (bucket defaults to `eligible`). */
function determination(
  over: Partial<EligibilityDetermination> = {},
): EligibilityDetermination {
  return {
    opportunity_id: "grants-360339",
    bucket: "eligible",
    satisfied_rules: [],
    failed_rules: [],
    unknown_rules: [],
    required_steps: [],
    ...over,
  };
}

/** A CAN-06 corpus snapshot whose data is `hours` old. */
function snapshot(
  hours: number,
  over: Partial<CurrentSnapshotResult> = {},
): CurrentSnapshotResult {
  const ms = Math.round(hours * 3_600_000);
  return {
    version: "canon-2026-08-15",
    data_age: { ms, hours, human: `${hours} hours` },
    retrieved_at: "2026-08-14T09:00:00.000Z",
    source_coverage: { alarms: [] },
    ...over,
  };
}

/** A CAN-05 per-opportunity freshness result — verified live-open by default. */
function freshness(over: Partial<FreshnessResult> = {}): FreshnessResult {
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
// 1 — fresh corpus + verified live-open opp → NOT stale, no caveat
// ---------------------------------------------------------------------------

test("fresh corpus + live-open opp → is_stale false, no caveat", () => {
  const out = annotateFreshness(determination(), {
    snapshot: snapshot(2),
    freshness: freshness(),
    now: NOW,
  });
  assert.equal(out.freshness.is_stale, false);
  assert.equal(out.freshness.caveat, null);
  assert.equal(out.freshness.data_as_of, "2026-08-14T09:00:00.000Z");
  assert.equal(out.freshness.assessed_at, NOW.toISOString());
  // Determination carried through unchanged.
  assert.deepEqual(out.determination, determination());
});

test("fresh corpus, no per-opp freshness supplied → still not stale", () => {
  const out = annotateFreshness(determination(), { snapshot: snapshot(2), now: NOW });
  assert.equal(out.freshness.is_stale, false);
  assert.equal(out.freshness.caveat, null);
});

// ---------------------------------------------------------------------------
// 2 — stale corpus (beyond cadence) → stale, caveat mentions age
// ---------------------------------------------------------------------------

test("stale corpus (data_age.hours > 24) → is_stale true, caveat names the age", () => {
  const out = annotateFreshness(determination(), {
    snapshot: snapshot(30),
    freshness: freshness(),
    now: NOW,
  });
  assert.equal(out.freshness.is_stale, true);
  assert.ok(out.freshness.caveat);
  assert.match(out.freshness.caveat!, /old/);
  assert.match(out.freshness.caveat!, /30 hours/);
  assert.match(out.freshness.caveat!, /24h/); // imported CANON_SYNC_CADENCE_HOURS
});

test("corpus exactly at cadence is NOT stale (strict > boundary)", () => {
  const out = annotateFreshness(determination(), {
    snapshot: snapshot(24),
    freshness: freshness(),
    now: NOW,
  });
  assert.equal(out.freshness.is_stale, false);
  assert.equal(out.freshness.caveat, null);
});

test("SyncHealthResult ALARM → stale, caveat surfaces CAN-06's reasons", () => {
  const health: SyncHealthResult = {
    status: "ALARM",
    reasons: ['latest snapshot "v1" recorded 1 sync alarm(s): grants.gov detail fetch degraded'],
    snapshot: snapshot(3),
    checked_at: NOW.toISOString(),
  };
  const out = annotateFreshness(determination(), { syncHealth: health, freshness: freshness(), now: NOW });
  assert.equal(out.freshness.is_stale, true);
  assert.match(out.freshness.caveat!, /sync alarm/);
  // data_as_of still comes from the alarmed snapshot.
  assert.equal(out.freshness.data_as_of, "2026-08-14T09:00:00.000Z");
});

// ---------------------------------------------------------------------------
// 3 — freshness_unavailable opp → stale, caveat names could-not-verify
// ---------------------------------------------------------------------------

test("freshness_unavailable opp → is_stale true, caveat names the source-outage / could-not-verify reason", () => {
  const out = annotateFreshness(determination(), {
    snapshot: snapshot(2), // fresh corpus, so only the opp reason fires
    freshness: freshness({
      status: null,
      close_date: undefined,
      days_remaining: undefined,
      freshness_unavailable: true,
      reason: "grants.gov circuit breaker open (degraded source)",
    }),
    now: NOW,
  });
  assert.equal(out.freshness.is_stale, true);
  assert.match(out.freshness.caveat!, /could not be re-verified/);
  assert.match(out.freshness.caveat!, /circuit breaker open/);
});

// ---------------------------------------------------------------------------
// 4 — closed opp → stale, caveat says closed
// ---------------------------------------------------------------------------

test("closed opp (days_remaining <= 0) → is_stale true, caveat says closed", () => {
  const out = annotateFreshness(determination(), {
    snapshot: snapshot(2), // fresh corpus, so only the opp reason fires
    freshness: freshness({
      status: "closed",
      close_date: "2026-08-12T23:59:59.000Z",
      days_remaining: -3,
    }),
    now: NOW,
  });
  assert.equal(out.freshness.is_stale, true);
  assert.match(out.freshness.caveat!, /has closed/);
});

test("delisted/not-found opp (status closed, no days_remaining) → still flagged closed", () => {
  const out = annotateFreshness(determination(), {
    snapshot: snapshot(2),
    freshness: freshness({
      status: "closed",
      close_date: undefined,
      days_remaining: undefined,
      reason: "grants.gov has no current record for this opportunity id",
    }),
    now: NOW,
  });
  assert.equal(out.freshness.is_stale, true);
  assert.match(out.freshness.caveat!, /has closed/);
});

// ---------------------------------------------------------------------------
// 5 — snapshot null → stale (treated as no known-current data)
// ---------------------------------------------------------------------------

test("snapshot null → is_stale true, data_as_of null, caveat names the missing snapshot", () => {
  const out = annotateFreshness(determination(), { snapshot: null, now: NOW });
  assert.equal(out.freshness.is_stale, true);
  assert.equal(out.freshness.data_as_of, null);
  assert.match(out.freshness.caveat!, /no Canon corpus snapshot/);
});

test("no corpus signal at all (both omitted) → treated as stale", () => {
  const out = annotateFreshness(determination(), { now: NOW });
  assert.equal(out.freshness.is_stale, true);
  assert.equal(out.freshness.data_as_of, null);
  assert.ok(out.freshness.caveat);
});

// ---------------------------------------------------------------------------
// Multiple reasons combine clearly
// ---------------------------------------------------------------------------

test("stale corpus AND unverifiable opp → caveat combines both reasons", () => {
  const out = annotateFreshness(determination(), {
    snapshot: snapshot(48),
    freshness: freshness({
      status: null,
      close_date: undefined,
      days_remaining: undefined,
      freshness_unavailable: true,
      reason: "grants.gov fetchOpportunity failed: timeout",
    }),
    now: NOW,
  });
  assert.equal(out.freshness.is_stale, true);
  assert.match(out.freshness.caveat!, /old/);
  assert.match(out.freshness.caveat!, /could not be re-verified/);
});

// ---------------------------------------------------------------------------
// Purity — no mutation, deterministic, bucket untouched
// ---------------------------------------------------------------------------

test("pure: identical inputs → deep-equal output; input determination unchanged", () => {
  const det = determination({ bucket: "conditionally_eligible" });
  const before = structuredClone(det);

  const opts = () => ({
    snapshot: snapshot(30),
    freshness: freshness({ status: null, freshness_unavailable: true, close_date: undefined, days_remaining: undefined }),
    now: NOW,
  });

  const o1 = annotateFreshness(det, opts());
  const o2 = annotateFreshness(det, opts());

  // Deterministic.
  assert.deepEqual(o1, o2);
  // Input never mutated.
  assert.deepEqual(det, before);
  // Same object carried through (bucket never changed).
  assert.equal((o1 as EligibilityDeterminationWithFreshness).determination, det);
  assert.equal(o1.determination.bucket, "conditionally_eligible");
});
