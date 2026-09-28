import { test, describe } from "node:test";
import assert from "node:assert/strict";
import precomputed from "../../../data/precomputed.json";
import { isPastAward, dropPastAwardMatches } from "../pastAwards";
import type { OpportunityMap } from "../../types";

describe("data/precomputed.json", () => {
  const entries = precomputed as unknown as { id: string; key: string; map: OpportunityMap }[];

  test("has entries", () => {
    assert.ok(entries.length > 0);
  });

  for (const entry of entries) {
    test(`${entry.id}: no past-award matches`, () => {
      const pastAward = entry.map.matches.filter((m) => isPastAward(m.opportunity));
      assert.deepEqual(pastAward.map((m) => m.opportunity.id), []);
    });

    test(`${entry.id}: summary + agencyIntelligence are derived from its own matches`, () => {
      const rebuilt = dropPastAwardMatches(entry.map, Date.now());
      assert.equal(entry.map.summary.highPotential, rebuilt.summary.highPotential);
      assert.equal(entry.map.summary.agencies, rebuilt.summary.agencies);
      assert.equal(entry.map.summary.fundingIdentified, rebuilt.summary.fundingIdentified);
      assert.deepEqual(entry.map.agencyIntelligence, rebuilt.agencyIntelligence);
    });
  }
});
