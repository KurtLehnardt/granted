import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { isExpiredDeadline, dropExpiredOpportunities, dropExpiredMatches } from "../expiry";

const NOW = Date.parse("2026-09-27T00:00:00.000Z");

describe("isExpiredDeadline", () => {
  test("true for a past deadline", () => {
    assert.equal(isExpiredDeadline("2020-01-01", NOW), true);
  });
  test("false for a future deadline", () => {
    assert.equal(isExpiredDeadline("2099-01-01", NOW), false);
  });
  test("false for missing/undefined deadline (evergreen)", () => {
    assert.equal(isExpiredDeadline(undefined, NOW), false);
    assert.equal(isExpiredDeadline("", NOW), false);
  });
  test("false for an unparseable deadline (never fabricate expiry)", () => {
    assert.equal(isExpiredDeadline("not-a-date", NOW), false);
  });
});

describe("dropExpiredOpportunities", () => {
  test("filters only records with a past deadline", () => {
    const opps = [
      { id: "a", deadline: "2020-01-01" },
      { id: "b", deadline: "2099-01-01" },
      { id: "c" },
    ];
    const kept = dropExpiredOpportunities(opps, NOW);
    assert.deepEqual(kept.map((o) => o.id), ["b", "c"]);
  });
});

describe("dropExpiredMatches", () => {
  function match(id: string, deadline?: string) {
    return { opportunity: { id, deadline } as any, tier: "verify", score: 50 } as any;
  }
  test("drops expired matches and recomputes closingIn90Days", () => {
    const soon = new Date(NOW + 10 * 864e5).toISOString();
    const map = {
      version: 1,
      profile: {} as any,
      followUps: [],
      summary: { highPotential: 2, fundingIdentified: 0, agencies: 2, closingIn90Days: 2 },
      matches: [match("expired", "2020-01-01"), match("live", soon)],
      agencyIntelligence: undefined,
    } as any;
    const result = dropExpiredMatches(map, NOW);
    assert.deepEqual(result.matches.map((m: any) => m.opportunity.id), ["live"]);
    assert.equal(result.summary.closingIn90Days, 1);
    // untouched fields survive
    assert.equal(result.summary.highPotential, 2);
  });
});
