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
  function match(
    over: { id: string; source: string; agency?: string; whyFit?: string } & Record<string, unknown>,
  ): Match {
    const { agency, whyFit, ...oppOver } = over;
    return {
      opportunity: opp({ agency: agency ?? "Agency", ...oppOver }),
      tier: "verify",
      score: 40,
      criteria: [],
      whyFit,
    } as unknown as Match;
  }

  test("filters past-award matches out of a cached/precomputed map and recomputes closingIn90Days, summary and agencyIntelligence", () => {
    const soon = new Date(Date.now() + 5 * 864e5).toISOString().slice(0, 10);
    const map: OpportunityMap = {
      version: "1.0.0",
      profile: {} as OpportunityMap["profile"],
      followUps: [],
      summary: { highPotential: 3, fundingIdentified: 0, agencies: 2, closingIn90Days: 1 },
      matches: [
        match({ id: "grants-1", source: "grants.gov", deadline: soon, agency: "NSF" }),
        match({
          id: "sbir-award-1",
          source: "sbir",
          deadline: soon,
          agency: "DoD",
          whyFit: "The contract was awarded for R&D services.",
        }),
        match({ id: "usasp-1", source: "usaspending", status: "closed", agency: "DoD" }),
      ],
      weakFieldFinding: undefined,
      agencyIntelligence: [
        { agency: "NSF", why: "", opportunityCount: 1 },
        { agency: "DoD", why: "The contract was awarded for R&D services.", opportunityCount: 2 },
      ],
    };
    const out = dropPastAwardMatches(map);
    assert.deepEqual(out.matches.map((m) => m.opportunity.id), ["grants-1"]);
    assert.equal(out.summary.closingIn90Days, 1);
    assert.equal(out.summary.highPotential, 1);
    assert.equal(out.summary.agencies, 1);
    assert.deepEqual(out.agencyIntelligence, [{ agency: "NSF", why: "", opportunityCount: 1 }]);
  });

  test("rebuilds a discernment map's worthVerifying and mapVerdict from the surviving matches", () => {
    const rec = (recommendation: string) => ({ recommendation, reasons: [] });
    const map = {
      version: "1.0.0",
      profile: {},
      followUps: [],
      summary: { highPotential: 1, worthVerifying: 1, fundingIdentified: 0, agencies: 1, closingIn90Days: 0 },
      mapVerdict: "strong_map",
      matches: [
        { ...match({ id: "sbir-award-1", source: "sbir" }), recommendation: rec("recommend") },
        { ...match({ id: "grants-1", source: "grants.gov" }), recommendation: rec("verify") },
      ],
      agencyIntelligence: [{ agency: "Agency", why: "", opportunityCount: 1 }],
    } as unknown as OpportunityMap;
    const out = dropPastAwardMatches(map);
    assert.equal(out.summary.highPotential, 0);
    assert.equal(out.summary.worthVerifying, 1);
    assert.equal(out.mapVerdict, "thin_map");
    assert.deepEqual(out.agencyIntelligence, []);
  });
});
