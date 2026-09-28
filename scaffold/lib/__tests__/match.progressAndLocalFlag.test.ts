import { test, afterEach } from "node:test";
import assert from "node:assert/strict";

import { buildOpportunityMap, type BuildDeps, type StepEvent } from "../match";
import { EligibilityDeterminationSchema, type EligibilityDetermination } from "../contracts/eligibilityDetermination";
import type { Opportunity, StartupProfile } from "../types";

/**
 * (2) preDone (early-excluded candidates) must feed `pct` but never the
 *     "done/total" `detail` SearchProgress uses to extrapolate remaining time
 *     — those candidates never touched the LLM, so folding them into the rate
 *     calculation would understate how long the remaining, LLM-bound
 *     candidates will actually take.
 * (3) NEXT_PUBLIC_FLAG_E3_TWO_PASS=false forces single-pass on local; unset
 *     (or any other value) keeps two-pass as the local default.
 */

const QUERY_VEC = [1, 0];
const FLAG_ENV = "NEXT_PUBLIC_FLAG_E3_TWO_PASS";
const savedProvider = process.env.LLM_PROVIDER;

afterEach(() => {
  delete process.env[FLAG_ENV];
  if (savedProvider === undefined) delete process.env.LLM_PROVIDER;
  else process.env.LLM_PROVIDER = savedProvider;
});

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

const corpus: Opportunity[] = [opp("excluded-1"), opp("eligible-1"), opp("eligible-2")];
const profile: StartupProfile = { description: "We build sensing hardware.", employees: 20 };

const excludedDetermination: EligibilityDetermination = EligibilityDeterminationSchema.parse({
  opportunity_id: "excluded-1",
  bucket: "excluded",
  satisfied_rules: [],
  failed_rules: [
    { rule_id: "test-entity-type", category: "size_ownership", description: "Individuals are not eligible.", provenance: "verified" },
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

const DETERMINATIONS: Record<string, EligibilityDetermination> = {
  "excluded-1": excludedDetermination,
  "eligible-1": eligibleDetermination,
  "eligible-2": { ...eligibleDetermination, opportunity_id: "eligible-2" },
};

function baseDeps(): Partial<BuildDeps> {
  return {
    corpus,
    extractProfile: async () => ({ profile, followUps: [] }),
    embed: async () => QUERY_VEC,
    screen: (_profile, o) => DETERMINATIONS[o.id],
    explainMatches: async (_p, candidates, _m, onBatch) => {
      const assessments = candidates.map((c) => ({
        id: c.id,
        score: 50,
        tier: "verify" as const,
        criteria: [],
        whyCare: `care ${c.id}`,
        whyFit: `fit ${c.id}`,
        whyIneligible: "",
        whatToVerify: "",
        whatToDoNext: "",
      }));
      onBatch?.(assessments, candidates.length, candidates.length);
      return assessments;
    },
    explainWeakField: async () => ({
      headline: "No strong federal match yet",
      reasoning: "Early for the programs in scope.",
      redirects: [],
    }),
  };
}

test("preDone counts toward pct but the score-progress detail excludes it", async () => {
  const steps: StepEvent[] = [];
  await buildOpportunityMap(profile.description, (e) => steps.push(e), baseDeps());

  const progress = steps.filter((e) => e.key === "score-progress");
  assert.ok(progress.length > 0, "at least one score-progress event fires");

  // 1 pre-excluded + 2 scored = 3 total retrieved candidates; pct must credit
  // the pre-excluded one as already-done progress.
  const last = progress[progress.length - 1];
  assert.equal(last.pct, 52 + Math.round((3 / 3) * 36));

  // But `detail` (done/total) must reflect ONLY the LLM-scored candidates —
  // never the free, instant pre-exclusion — since SearchProgress uses it to
  // extrapolate a per-candidate LLM rate.
  for (const e of progress) {
    const [done, total] = e.detail!.split("/").map(Number);
    assert.ok(done <= 2, `detail done (${done}) must never include the pre-excluded candidate`);
    assert.equal(total, 2, "detail total must be the scorable count, not the retrieved count");
  }
  assert.equal(last.detail, "2/2");
});

test("local: NEXT_PUBLIC_FLAG_E3_TWO_PASS unset defaults to two-pass", async () => {
  process.env.LLM_PROVIDER = "ollama";
  delete process.env[FLAG_ENV];
  const spy = { single: 0, two: 0 };
  const d = baseDeps();
  d.explainMatches = async (...args) => {
    spy.single += 1;
    return baseDeps().explainMatches!(...args);
  };
  d.explainMatchesTwoPass = async (_p, candidates) => {
    spy.two += 1;
    return candidates.map((c) => ({
      id: c.id, score: 50, tier: "verify" as const, criteria: [],
      whyCare: "", whyFit: "", whyIneligible: "", whatToVerify: "", whatToDoNext: "",
    }));
  };
  await buildOpportunityMap(profile.description, undefined, d);
  assert.equal(spy.two, 1, "two-pass runs by default on local");
  assert.equal(spy.single, 0);
});

test("local: NEXT_PUBLIC_FLAG_E3_TWO_PASS=false forces single-pass", async () => {
  process.env.LLM_PROVIDER = "ollama";
  process.env[FLAG_ENV] = "false";
  const spy = { single: 0, two: 0 };
  const d = baseDeps();
  d.explainMatches = async (...args) => {
    spy.single += 1;
    return baseDeps().explainMatches!(...args);
  };
  d.explainMatchesTwoPass = async (_p, candidates) => {
    spy.two += 1;
    return candidates.map((c) => ({
      id: c.id, score: 50, tier: "verify" as const, criteria: [],
      whyCare: "", whyFit: "", whyIneligible: "", whatToVerify: "", whatToDoNext: "",
    }));
  };
  await buildOpportunityMap(profile.description, undefined, d);
  assert.equal(spy.single, 1, "explicit false forces single-pass even on local");
  assert.equal(spy.two, 0);
});
