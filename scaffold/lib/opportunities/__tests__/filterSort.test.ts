import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  awardAmountForSort,
  availableLocations,
  filterByLocation,
  sortMatches,
  type FilterableMatch,
} from "../filterSort";

/**
 * Pure, hermetic tests of the match-results filter/sort helpers (location,
 * match %, award amount, recency).
 */

function m(
  id: string,
  opts: {
    score?: number;
    geography?: string;
    fundingLow?: number;
    fundingHigh?: number;
    awardRange?: { floor?: number; ceiling?: number };
    retrieved_at?: string;
  } = {},
): FilterableMatch {
  return {
    score: opts.score,
    opportunity: {
      id,
      geography: opts.geography,
      fundingLow: opts.fundingLow,
      fundingHigh: opts.fundingHigh,
      award_range: opts.awardRange,
      retrieved_at: opts.retrieved_at,
    },
  };
}

describe("awardAmountForSort", () => {
  test("award_range wins over legacy fundingLow/fundingHigh, same precedence as buildFundingRange", () => {
    const match = m("1", { fundingHigh: 100, awardRange: { ceiling: 500 } });
    assert.equal(awardAmountForSort(match), 500);
  });

  test("falls back to fundingHigh, then fundingLow, when award_range is absent", () => {
    assert.equal(awardAmountForSort(m("1", { fundingHigh: 200 })), 200);
    assert.equal(awardAmountForSort(m("1", { fundingLow: 50 })), 50);
  });

  test("returns undefined (never 0) when nothing is known", () => {
    assert.equal(awardAmountForSort(m("1")), undefined);
    assert.equal(awardAmountForSort(m("1", { fundingHigh: 0, fundingLow: 0 })), undefined);
  });
});

describe("availableLocations", () => {
  test("distinct, normalized, alphabetical; skips matches with no geography", () => {
    const matches = [m("1", { geography: "California" }), m("2", { geography: "CA" }), m("3", { geography: "Illinois" }), m("4", {})];
    // "California" and "CA" both normalize to the same state -- one entry, not two.
    assert.deepEqual(availableLocations(matches), ["California", "Illinois"]);
  });

  test("empty/absent matches -> empty array, never throws", () => {
    assert.deepEqual(availableLocations([]), []);
    assert.deepEqual(availableLocations(null), []);
    assert.deepEqual(availableLocations(undefined), []);
  });
});

describe("filterByLocation", () => {
  const matches = [
    m("ca1", { geography: "California" }),
    m("il1", { geography: "Illinois" }),
    m("fed1", {}), // nationwide/geography-less, e.g. a grants.gov record
  ];

  test("null/undefined state -> no filter, returns everything unchanged", () => {
    assert.deepEqual(
      filterByLocation(matches, null).map((x) => x.opportunity!.id),
      ["ca1", "il1", "fed1"],
    );
    assert.deepEqual(
      filterByLocation(matches, undefined).map((x) => x.opportunity!.id),
      ["ca1", "il1", "fed1"],
    );
  });

  test("a specific state keeps that state's matches PLUS every geography-less match -- never hides a nationwide opportunity", () => {
    const filtered = filterByLocation(matches, "California");
    assert.deepEqual(filtered.map((x) => x.opportunity!.id), ["ca1", "fed1"]);
  });

  test("an abbreviation/full-name mismatch still matches via the shared state normalizer", () => {
    const filtered = filterByLocation(matches, "CA");
    assert.deepEqual(filtered.map((x) => x.opportunity!.id), ["ca1", "fed1"]);
  });

  test("a state with no matches at all still keeps every geography-less match", () => {
    const filtered = filterByLocation(matches, "Texas");
    assert.deepEqual(filtered.map((x) => x.opportunity!.id), ["fed1"]);
  });

  test("a PRESENT but unrecognizable geography is treated the same as absent -- never hidden by a specific-state filter", () => {
    // Real review finding: a naive `!geo || statesMatch(...)` check only
    // protects an ABSENT geography. A garbled-but-present value (e.g. a
    // future bad scrape writing "N/A") is just as unscoped as absent, but
    // must get the same treatment, not the opposite.
    const withGarbled = [...matches, m("garbled", { geography: "N/A" })];
    const filtered = filterByLocation(withGarbled, "California");
    assert.deepEqual(filtered.map((x) => x.opportunity!.id), ["ca1", "fed1", "garbled"]);
  });
});

describe("sortMatches", () => {
  test("'match' sorts by score descending, id-asc tiebreak (the pipeline's own default order)", () => {
    const matches = [m("b", { score: 50 }), m("a", { score: 50 }), m("c", { score: 90 })];
    const sorted = sortMatches(matches, "match");
    assert.deepEqual(sorted.map((x) => x.opportunity!.id), ["c", "a", "b"]);
  });

  test("'award' sorts by awardAmountForSort descending, no-data matches last regardless of direction", () => {
    const matches = [
      m("none", { score: 99 }), // highest score, but no funding data at all
      m("low", { score: 10, fundingHigh: 1000 }),
      m("high", { score: 10, fundingHigh: 50_000 }),
    ];
    const sorted = sortMatches(matches, "award");
    assert.deepEqual(sorted.map((x) => x.opportunity!.id), ["high", "low", "none"]);
  });

  test("'recency' sorts by retrieved_at descending (newest first), missing-timestamp last", () => {
    const matches = [
      m("none", { score: 99 }), // no retrieved_at at all
      m("old", { retrieved_at: "2026-01-01T00:00:00.000Z" }),
      m("new", { retrieved_at: "2026-06-01T00:00:00.000Z" }),
    ];
    const sorted = sortMatches(matches, "recency");
    assert.deepEqual(sorted.map((x) => x.opportunity!.id), ["new", "old", "none"]);
  });

  test("never changes membership -- only order", () => {
    const matches = [m("1", { score: 10 }), m("2", { score: 90 })];
    for (const key of ["match", "award", "recency"] as const) {
      const sorted = sortMatches(matches, key);
      assert.deepEqual(
        new Set(sorted.map((x) => x.opportunity!.id)),
        new Set(["1", "2"]),
      );
    }
  });

  test("empty/absent matches -> empty array, never throws", () => {
    assert.deepEqual(sortMatches([], "match"), []);
    assert.deepEqual(sortMatches(null, "award"), []);
    assert.deepEqual(sortMatches(undefined, "recency"), []);
  });
});
