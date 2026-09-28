import { test } from "node:test";
import assert from "node:assert/strict";

import { cached } from "../handler";
import type { OpportunityMap, Match } from "@/lib/types";

function opp(over: { id: string; source: string } & Record<string, unknown>) {
  return { kind: "grant", program: "Program", agency: "Agency", description: "A description.", ...over };
}

function match(over: { id: string; source: string; agency?: string; whyFit?: string } & Record<string, unknown>): Match {
  const { agency, whyFit, ...oppOver } = over;
  return { opportunity: opp({ agency: agency ?? "Agency", ...oppOver }), tier: "verify", score: 40, criteria: [], whyFit } as unknown as Match;
}

test("cached() strips past-award matches out of a precomputed map, not just the raw matches array", () => {
  const map: OpportunityMap = {
    version: "1.0.0",
    profile: {} as OpportunityMap["profile"],
    followUps: [],
    summary: { highPotential: 2, fundingIdentified: 0, agencies: 2, closingIn90Days: 0 },
    matches: [
      match({ id: "grants-1", source: "grants.gov", agency: "NSF" }),
      match({
        id: "sbir-award-1",
        source: "sbir",
        agency: "DoD",
        whyFit: "The contract was awarded for R&D services.",
      }),
    ],
    weakFieldFinding: undefined,
    agencyIntelligence: [
      { agency: "NSF", why: "", opportunityCount: 1 },
      { agency: "DoD", why: "The contract was awarded for R&D services.", opportunityCount: 1 },
    ],
  };
  const fixtureSource = [{ key: "some description", map }];

  const out = cached("some description", fixtureSource) as OpportunityMap;

  assert.ok(out);
  assert.deepEqual(out.matches.map((m) => m.opportunity.id), ["grants-1"]);
  assert.deepEqual(out.agencyIntelligence, [{ agency: "NSF", why: "", opportunityCount: 1 }]);
  assert.equal(out.summary.highPotential, 1);
  assert.equal(out.summary.agencies, 1);
});

test("cached() returns undefined when no precomputed entry matches the key", () => {
  assert.equal(cached("no such description", []), undefined);
});
