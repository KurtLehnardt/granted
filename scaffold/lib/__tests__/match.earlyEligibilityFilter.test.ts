import { test } from "node:test";
import assert from "node:assert/strict";

import { buildOpportunityMap, type BuildDeps } from "../match";
import { EligibilityDeterminationSchema, type EligibilityDetermination } from "../contracts/eligibilityDetermination";
import type { Opportunity, StartupProfile } from "../types";

/**
 * Early eligibility filter: a DEFINITIVE, rule-based `excluded` determination
 * (the same one `screen()` would attach after scoring today) is computed on
 * retrieved candidates BEFORE they reach the LLM scorer — so it costs zero
 * model calls — while still appearing in the final map exactly as it does
 * today (with an eligibility determination and a `whyIneligible` field).
 * Uncertain buckets (`eligible`/`conditionally_eligible`/`unknown`) are never
 * pre-filtered; only `excluded` is.
 */

const QUERY_VEC = [1, 0];

function opp(id: string): Opportunity {
  return {
    id,
    source: "grants.gov",
    kind: "grant",
    program: `program ${id}`,
    agency: "TestAgency",
    description: `A grant opportunity ${id}.`,
    eligibility: "US small business.",
    embedding: QUERY_VEC,
  };
}

const corpus: Opportunity[] = [opp("excluded-1"), opp("eligible-1"), opp("unknown-1")];

const profile: StartupProfile = { description: "We build sensing hardware.", employees: 20 };

const excludedDetermination: EligibilityDetermination = EligibilityDeterminationSchema.parse({
  opportunity_id: "excluded-1",
  bucket: "excluded",
  satisfied_rules: [],
  failed_rules: [
    {
      rule_id: "test-entity-type",
      category: "size_ownership",
      description: "Individuals are not eligible for this program.",
      provenance: "verified",
    },
  ],
  unknown_rules: [],
  required_steps: [],
});

const eligibleDetermination: EligibilityDetermination = EligibilityDeterminationSchema.parse({
  opportunity_id: "eligible-1",
  bucket: "eligible",
  satisfied_rules: [],
  failed_rules: [],
  unknown_rules: [],
  required_steps: [],
});

const unknownDetermination: EligibilityDetermination = EligibilityDeterminationSchema.parse({
  opportunity_id: "unknown-1",
  bucket: "unknown",
  satisfied_rules: [],
  failed_rules: [],
  unknown_rules: [
    { rule_id: "test-size", category: "size_ownership", description: "Employee count not confirmed.", provenance: "model_inferred" },
  ],
  required_steps: [],
});

const DETERMINATIONS: Record<string, EligibilityDetermination> = {
  "excluded-1": excludedDetermination,
  "eligible-1": eligibleDetermination,
  "unknown-1": unknownDetermination,
};

function deps(scored: { calls: number; seenIds: string[] }): Partial<BuildDeps> {
  return {
    corpus,
    extractProfile: async () => ({ profile, followUps: [] }),
    embed: async () => QUERY_VEC,
    screen: (_profile, o) => DETERMINATIONS[o.id],
    explainMatches: async (_p, candidates) => {
      scored.calls += 1;
      scored.seenIds.push(...candidates.map((c) => c.id));
      return candidates.map((c) => ({
        id: c.id,
        score: 50,
        tier: "verify" as const,
        criteria: [],
        whyCare: `care ${c.id}`,
        whyFit: `fit ${c.id}`,
        whyIneligible: `verify ${c.id}`,
        whatToVerify: `check ${c.id}`,
        whatToDoNext: `next ${c.id}`,
      }));
    },
    explainWeakField: async () => ({
      headline: "No strong federal match yet",
      reasoning: "Early for the programs in scope.",
      redirects: [],
    }),
  };
}

test("an excluded candidate is filtered before scoring, costs no LLM call, but still appears in the final map", async () => {
  const scored = { calls: 0, seenIds: [] as string[] };
  const map = await buildOpportunityMap(profile.description, undefined, deps(scored));

  // The scorer only ever saw the two non-excluded candidates.
  assert.deepEqual(new Set(scored.seenIds), new Set(["eligible-1", "unknown-1"]));
  assert.ok(!scored.seenIds.includes("excluded-1"), "the excluded candidate never reaches the LLM");

  // It still appears in the final map, with its eligibility + a whyIneligible.
  const byId = new Map(map.matches.map((m) => [m.opportunity.id, m]));
  assert.equal(map.matches.length, 3, "no candidate is dropped");
  const excluded = byId.get("excluded-1")!;
  assert.equal(excluded.eligibility?.determination.bucket, "excluded");
  assert.equal(typeof excluded.whyIneligible, "string");
  assert.equal(excluded.score, 0, "never scored — carries a neutral score, not a fabricated one");

  // The other two were scored normally and carry the mock's narrative.
  assert.equal(byId.get("eligible-1")!.whyFit, "fit eligible-1");
  assert.equal(byId.get("unknown-1")!.whyFit, "fit unknown-1");
  assert.equal(byId.get("eligible-1")!.eligibility?.determination.bucket, "eligible");
  assert.equal(byId.get("unknown-1")!.eligibility?.determination.bucket, "unknown");
});

test("a screen() error never drops a candidate — it falls through to normal scoring", async () => {
  const scored = { calls: 0, seenIds: [] as string[] };
  const d = deps(scored);
  d.screen = () => {
    throw new Error("screening blew up");
  };
  const map = await buildOpportunityMap(profile.description, undefined, d);

  // Every candidate still reached the scorer (never silently dropped on an
  // uncertain/errored signal) and appears in the final map.
  assert.equal(scored.seenIds.length, corpus.length);
  assert.equal(map.matches.length, corpus.length);
  for (const m of map.matches) assert.equal(m.eligibility, undefined);
});
