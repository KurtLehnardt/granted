import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { isPastAward, dropPastAwards, dropPastAwardMatches } from "../pastAwards";
import type { OpportunityMap, Match } from "../../types";

function opp(over: { id: string; source: string } & Record<string, unknown>): Record<string, unknown> {
  return {
    kind: "grant",
    program: "Program",
    agency: "Agency",
    description: "A description.",
    ...over,
  };
}

describe("isPastAward", () => {
  test("a sbir-award-* record is a past award", () => {
    assert.equal(isPastAward({ id: "sbir-award-abc123", source: "sbir" }), true);
  });

  test("a sbir record that is NOT id-prefixed sbir-award- is a live open solicitation, not a past award", () => {
    assert.equal(isPastAward({ id: "sbir-4821", source: "sbir" }), false);
  });

  test("a closed usaspending record is a past award", () => {
    assert.equal(isPastAward({ id: "usasp-1", source: "usaspending", status: "closed" }), true);
  });

  test("a non-closed usaspending record is not a past award", () => {
    assert.equal(isPastAward({ id: "usasp-1", source: "usaspending", status: "open" }), false);
    assert.equal(isPastAward({ id: "usasp-1", source: "usaspending" }), false);
  });

  test("every other source is never a past award", () => {
    assert.equal(isPastAward({ id: "grants-1", source: "grants.gov" }), false);
    assert.equal(isPastAward({ id: "sam-1", source: "assistance-listings" }), false);
  });
});

describe("dropPastAwards", () => {
  test("filters out only past-award records, preserving order of the rest", () => {
    const records = [
      opp({ id: "grants-1", source: "grants.gov" }),
      opp({ id: "sbir-award-1", source: "sbir" }),
      opp({ id: "sbir-open-1", source: "sbir" }),
      opp({ id: "usasp-1", source: "usaspending", status: "closed" }),
      opp({ id: "sam-1", source: "assistance-listings" }),
    ];
    const out = dropPastAwards(records as any[]);
    assert.deepEqual(out.map((o) => o.id), ["grants-1", "sbir-open-1", "sam-1"]);
  });
});

describe("dropPastAwardMatches", () => {
  function match(over: { id: string; source: string } & Record<string, unknown>): Match {
    return { opportunity: opp(over), tier: "verify", score: 40, criteria: [] } as unknown as Match;
  }

  test("filters past-award matches out of a cached/precomputed map and recomputes closingIn90Days", () => {
    const soon = new Date(Date.now() + 5 * 864e5).toISOString().slice(0, 10);
    const map: OpportunityMap = {
      version: "1.0.0",
      profile: {} as OpportunityMap["profile"],
      followUps: [],
      summary: { highPotential: 2, fundingIdentified: 0, agencies: 1, closingIn90Days: 1 },
      matches: [
        match({ id: "grants-1", source: "grants.gov", deadline: soon }),
        match({ id: "sbir-award-1", source: "sbir", deadline: soon }),
        match({ id: "usasp-1", source: "usaspending", status: "closed" }),
      ],
      weakFieldFinding: undefined,
      agencyIntelligence: [],
    };
    const out = dropPastAwardMatches(map);
    assert.deepEqual(out.matches.map((m) => m.opportunity.id), ["grants-1"]);
    assert.equal(out.summary.closingIn90Days, 1);
    // Everything else on summary is left as-is (mirrors dropExpiredMatches).
    assert.equal(out.summary.highPotential, 2);
  });
});
