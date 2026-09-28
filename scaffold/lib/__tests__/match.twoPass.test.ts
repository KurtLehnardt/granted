import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";

import { buildOpportunityMap, tierFromScore, type BuildDeps } from "../match";
import { screen as realScreen } from "../eligibility/screen";
import {
  promotedIds,
  assembleTwoPass,
  PROMOTION_FLOOR,
  type Assessment,
  type PassAScore,
} from "../scoring/twoPass";
import type { Opportunity, StartupProfile } from "../types";

/**
 * E3 — two-pass scoring, wired through the real `buildOpportunityMap` pipeline
 * behind the `e3_two_pass` flag (hermetic: LLM/embedding/screen + corpus are
 * injected, nothing hits the network).
 *
 * Proves the two guarantees the task requires:
 *   (a) FLAG OFF → the single-pass `explainMatches` runs, byte-unchanged; the
 *       two-pass scorer is never touched, and the output equals the baseline.
 *   (b) FLAG ON  → the two-pass scorer runs and reproduces the SAME tier bands
 *       as flag-off for a fixed mocked scoring set (the injected flag-on scorer
 *       drives the REAL `promotedIds` + `assembleTwoPass` merge, so this exercises
 *       the actual two-pass logic, not a stand-in).
 */

const FLAG_ENV = "NEXT_PUBLIC_FLAG_E3_TWO_PASS";
const QUERY_VEC = [1, 0];

// A fixed scoring set spanning every tier band: likely(>=60), verify(>=33),
// adjacent(25-32, promoted), none(<25, NOT promoted).
const SCORES: Record<string, number> = {
  "opp-likely": 72,
  "opp-verify": 40,
  "opp-adjacent": 28,
  "opp-none": 15,
};

function opp(id: string): Opportunity {
  return {
    id,
    source: "grants.gov",
    kind: "grant",
    program: `program ${id}`,
    agency: "TestAgency",
    description: `A grant opportunity ${id} for testing two-pass scoring.`,
    eligibility: "US small business.",
    embedding: QUERY_VEC, // cosine 1 with the query → clears candidateFloor
  };
}

const fixtureCorpus: Opportunity[] = Object.keys(SCORES).map(opp);

const fixtureProfile: StartupProfile = {
  description: "We build advanced AI sensing hardware for federal customers.",
  employees: 20,
};

function full(id: string, score: number): Assessment {
  return {
    id,
    score,
    tier: "likely",
    criteria: [],
    whyCare: `care ${id}`,
    whyFit: `fit ${id}`,
    whyIneligible: `verify ${id}`,
    whatToVerify: `check ${id}`,
    whatToDoNext: `next ${id}`,
  };
}

/** The single-pass baseline: full assessment for every candidate. */
const baselineExplainMatches: BuildDeps["explainMatches"] = async (_p, candidates) =>
  candidates.map((c) => full(c.id, SCORES[c.id] ?? 0));

/**
 * A faithful in-memory stand-in for the REAL `explainMatchesTwoPass`: it derives
 * Pass-A scores from the fixed set, promotes via the REAL `promotedIds`, builds
 * Pass-B narratives only for the promoted, and merges via the REAL
 * `assembleTwoPass` — the exact composition `lib/claude.ts` performs, minus the
 * network. So a passing tier-equivalence assertion is a property of the real
 * merge code, not of this mock.
 */
const twoPassExplain: BuildDeps["explainMatchesTwoPass"] = async (_p, candidates) => {
  const passA: PassAScore[] = candidates.map((c) => ({ id: c.id, score: SCORES[c.id] ?? 0 }));
  const promoted = promotedIds(passA, PROMOTION_FLOOR);
  const passB: Assessment[] = candidates
    .filter((c) => promoted.has(c.id))
    .map((c) => full(c.id, SCORES[c.id] ?? 0));
  return assembleTwoPass(candidates.map((c) => c.id), passA, passB);
};

function deps(spy: { single: number; two: number }): Partial<BuildDeps> {
  return {
    corpus: fixtureCorpus,
    extractProfile: async () => ({ profile: fixtureProfile, followUps: [] }),
    embed: async () => QUERY_VEC,
    explainMatches: async (p, candidates, m, ob, s) => {
      spy.single += 1;
      return baselineExplainMatches(p, candidates, m, ob, s);
    },
    explainMatchesTwoPass: async (p, candidates, m, ob, s) => {
      spy.two += 1;
      return twoPassExplain(p, candidates, m, ob, s);
    },
    explainWeakField: async () => ({
      headline: "No strong federal match yet",
      reasoning: "Early for the programs in scope.",
      redirects: [],
    }),
    screen: realScreen,
  };
}

/** id → tier map from a finished map's matches, for band-equivalence asserts. */
function tiers(map: Awaited<ReturnType<typeof buildOpportunityMap>>): Map<string, string> {
  return new Map(map.matches.map((m) => [m.opportunity.id, m.tier]));
}

afterEach(() => {
  delete process.env[FLAG_ENV];
});

describe("E3 two-pass — flag routing + tier reproduction", () => {
  test("(a) flag OFF: single-pass runs, two-pass scorer is never called", async () => {
    delete process.env[FLAG_ENV];
    const spy = { single: 0, two: 0 };
    const map = await buildOpportunityMap(fixtureProfile.description, undefined, deps(spy));

    assert.equal(spy.single, 1, "the single-pass explainMatches must run when the flag is off");
    assert.equal(spy.two, 0, "the two-pass scorer must NOT run when the flag is off");

    // Baseline tiers, straight from the fixed scoring set.
    assert.deepEqual(
      tiers(map),
      new Map(Object.entries(SCORES).map(([id, s]) => [id, tierFromScore(s)])),
    );
  });

  test("(b) flag ON: two-pass runs and reproduces the same tier bands as flag-off", async () => {
    // flag off → baseline tiers
    const offSpy = { single: 0, two: 0 };
    delete process.env[FLAG_ENV];
    const offMap = await buildOpportunityMap(fixtureProfile.description, undefined, deps(offSpy));

    // flag on → two-pass tiers
    const onSpy = { single: 0, two: 0 };
    process.env[FLAG_ENV] = "true";
    const onMap = await buildOpportunityMap(fixtureProfile.description, undefined, deps(onSpy));

    assert.equal(onSpy.two, 1, "the two-pass scorer must run when the flag is on");
    assert.equal(onSpy.single, 0, "the single-pass scorer must NOT run when the flag is on");

    // The sacred guarantee: identical tier bands across the two paths.
    assert.deepEqual(tiers(onMap), tiers(offMap), "flag-on tiers must equal flag-off tiers");

    // Spans all four bands (not a vacuous equality).
    assert.deepEqual(
      Object.keys(SCORES).map((id) => onMap.matches.find((m) => m.opportunity.id === id)!.tier),
      ["likely", "verify", "adjacent", "none"],
    );
  });

  test("(b-cont) flag ON: promoted candidates keep their narrative; non-promoted are score-only but still tier", async () => {
    process.env[FLAG_ENV] = "true";
    const spy = { single: 0, two: 0 };
    const map = await buildOpportunityMap(fixtureProfile.description, undefined, deps(spy));

    const byId = new Map(map.matches.map((m) => [m.opportunity.id, m]));
    // Promoted (>=25) render with a real narrative.
    assert.equal(byId.get("opp-adjacent")!.whyFit, "fit opp-adjacent");
    assert.equal(byId.get("opp-adjacent")!.tier, "adjacent");
    // Non-promoted (<25) still appear and still tier as `none`, just without narrative spend.
    const none = byId.get("opp-none")!;
    assert.equal(none.tier, "none");
    assert.equal(none.whyFit, "", "non-promoted candidate spends nothing on narrative");
    assert.equal(none.score, 15, "but keeps its Pass-A score so the tier computes");

    // Summary's high-potential count (score >= scoreFloor 33) is unchanged: likely+verify = 2.
    assert.equal(map.summary.highPotential, 2);
  });
});
