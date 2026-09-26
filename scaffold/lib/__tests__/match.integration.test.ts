import { test } from "node:test";
import assert from "node:assert/strict";

import { buildOpportunityMap, type BuildDeps, type StepEvent } from "../match";
import { screen as realScreen } from "../eligibility/screen";
import type { Opportunity, StartupProfile, Match } from "../types";

/**
 * Hermetic pipeline tests for `buildOpportunityMap` (H6) + the C1 regression.
 *
 * The pipeline's LLM/embedding/screen calls and its static corpus are injected
 * (the DI seam added for C1/H6), so NOTHING here touches OpenAI, Anthropic, or
 * the network. These assert the four load-bearing guarantees the review names:
 * never fabricates, never false-excludes, streams milestones in order, and
 * degrades gracefully when an auxiliary step throws — plus the specific
 * false-drop C1 fixed.
 */

// --- Fixtures ---------------------------------------------------------------

const QUERY_VEC = [1, 0, 0];

/**
 * The exact class of opportunity C1's deleted regex silently dropped: a
 * PERMISSIVE multi-entity NOFO whose eligibility prose contains
 * "only ... Institutions of Higher Education" as one item in a list that also
 * admits non-profits. `grants-353936`-shaped. It is open to more than IHEs, so
 * it must survive to a bucket, not be pre-screen dropped.
 */
const multiEntityNofo: Opportunity = {
  id: "grants-353936",
  source: "grants.gov",
  kind: "grant",
  program: "Mathematical Foundations of Artificial Intelligence",
  agency: "NSF",
  description: "Foundational research in the mathematics of AI.",
  eligibility:
    "Proposals may only be submitted by the following: - Non-profit, non-academic organizations - Institutions of Higher Education (IHEs) - State governments",
  embedding: [1, 0, 0],
};

/** An SBIR-sourced opp — the latent branch-1 false-exclude on inferred size. */
const sbirOpp: Opportunity = {
  id: "sbir-topic-x",
  source: "sbir",
  kind: "rd",
  program: "SBIR Phase I — Advanced Sensing",
  agency: "DoD",
  description: "Small Business Innovation Research topic on advanced sensing.",
  eligibility: "US small business.",
  embedding: [1, 0, 0],
};

const fixtureCorpus: Opportunity[] = [multiEntityNofo, sbirOpp];

const fixtureProfile: StartupProfile = {
  description: "We build advanced AI sensing hardware.",
  // Inferred headcount ABOVE the SBIR 500 cap AND non-zero — the two values the
  // deleted ruleGate branches keyed on. Post-C1 both opps must still survive.
  employees: 5000,
};

/** A full assessment for a candidate, all scoring "strong" unless overridden. */
function assess(id: string, score = 80) {
  return {
    id,
    score,
    tier: "likely" as const,
    criteria: [],
    whyCare: "This program funds exactly the sensing R&D you're doing.",
    whyFit: "Strong technical alignment.",
    whyIneligible: "Confirm your entity type and registration.",
    whatToVerify: "SAM registration.",
    whatToDoNext: "Register in SAM.gov.",
  };
}

/** Build an injectable dep set; override individual members per test. */
function deps(over: Partial<BuildDeps> = {}): Partial<BuildDeps> {
  return {
    corpus: fixtureCorpus,
    extractProfile: async () => ({ profile: fixtureProfile, followUps: [] }),
    embed: async () => QUERY_VEC,
    explainMatches: async (_p, candidates) =>
      candidates.map((c) => assess(c.id)),
    explainWeakField: async () => ({
      headline: "No strong federal match yet",
      reasoning: "Your work is early for the programs in scope.",
      redirects: [],
    }),
    screen: realScreen,
    ...over,
  };
}

// --- C1 regression ----------------------------------------------------------

test("C1: a previously-false-dropped multi-entity IHE NOFO now survives to a bucket", async () => {
  const map = await buildOpportunityMap(fixtureProfile.description, undefined, deps());

  const survivor = map.matches.find((m) => m.opportunity.id === "grants-353936");
  assert.ok(survivor, "grants-353936 must reach a match (not be pre-screen dropped)");
  assert.ok(survivor!.eligibility, "it must carry an eligibility determination");
  assert.notEqual(
    survivor!.eligibility!.determination.bucket,
    "excluded",
    "a permissive multi-entity NOFO must never land in `excluded`",
  );
});

// --- Never false-excludes ---------------------------------------------------

test("never false-excludes: an SBIR opp + inferred >500 employees screens as non-excluded (unknown, not a drop)", async () => {
  const map = await buildOpportunityMap(fixtureProfile.description, undefined, deps());

  const sbir = map.matches.find((m) => m.opportunity.id === "sbir-topic-x");
  assert.ok(sbir, "the SBIR opp must survive retrieval (no ruleGate size pre-filter)");
  assert.ok(sbir!.eligibility, "it must be screened by screen()");
  assert.notEqual(
    sbir!.eligibility!.determination.bucket,
    "excluded",
    "a model-inferred size overflow must render non-excluded (R8.4), never a silent drop",
  );
});

// --- Never fabricates -------------------------------------------------------

test("never fabricates: an assessment id absent from the candidate slice is dropped, not invented", async () => {
  const map = await buildOpportunityMap(fixtureProfile.description, undefined, deps({
    explainMatches: async (_p, candidates) => [
      ...candidates.map((c) => assess(c.id)),
      assess("ghost-not-in-corpus", 99), // model returns an id we never sent
    ],
  }));

  assert.equal(
    map.matches.filter((m) => m.opportunity.id === "ghost-not-in-corpus").length,
    0,
    "a hallucinated opportunity id must never appear in the output map",
  );
  // The real candidates still come through.
  assert.ok(map.matches.some((m) => m.opportunity.id === "grants-353936"));
});

// --- Streams milestones -----------------------------------------------------

test("streams milestones: normal path emits the exact key sequence with non-decreasing pct", async () => {
  const steps: StepEvent[] = [];
  await buildOpportunityMap(fixtureProfile.description, (e) => steps.push(e), deps());

  assert.deepEqual(
    steps.map((s) => s.key),
    ["start", "profile", "embed", "retrieve", "score", "assemble", "eligibility"],
  );
  for (let i = 1; i < steps.length; i++) {
    assert.ok(steps[i].pct >= steps[i - 1].pct, `pct must not decrease at step ${steps[i].key}`);
  }
});

test("streams milestones: zero-candidate path emits the weak-field sequence", async () => {
  const steps: StepEvent[] = [];
  const map = await buildOpportunityMap(fixtureProfile.description, (e) => steps.push(e), deps({
    // Orthogonal query vector → cosine 0 < candidateFloor → no candidates.
    embed: async () => [0, 1, 0],
  }));

  assert.deepEqual(steps.map((s) => s.key), ["start", "profile", "embed", "retrieve", "weak"]);
  assert.equal(map.matches.length, 0);
  assert.ok(map.weakFieldFinding, "the honest-no path must return a finding, not silence");
});

// --- Weak-field honest-no when nothing clears the bar -----------------------

test("weak field is a finding: candidates exist but none score strong → weakFieldFinding set", async () => {
  const map = await buildOpportunityMap(fixtureProfile.description, undefined, deps({
    explainMatches: async (_p, candidates) => candidates.map((c) => assess(c.id, 10)),
  }));

  assert.ok(map.weakFieldFinding, "a below-threshold field must yield a weakFieldFinding");
  assert.equal(map.summary.highPotential, 0);
  // Matches are still present (as adjacent/none), just not "strong".
  assert.ok(map.matches.length > 0);
});

// --- Degrades on a screen() throw -------------------------------------------

test("a screen() throw for one match never breaks the search: that match omits eligibility, others keep it", async () => {
  const map = await buildOpportunityMap(fixtureProfile.description, undefined, deps({
    screen: (cp, opp) => {
      if (opp.id === "sbir-topic-x") throw new Error("boom");
      return realScreen(cp, opp);
    },
  }));

  const sbir = map.matches.find((m) => m.opportunity.id === "sbir-topic-x");
  const other = map.matches.find((m) => m.opportunity.id === "grants-353936");
  assert.ok(sbir, "the search still returns the match whose screen() threw");
  assert.equal(sbir!.eligibility, undefined, "its eligibility field is simply omitted");
  assert.ok(other, "other matches are unaffected");
  assert.ok(other!.eligibility, "and keep their eligibility determination");
});

// --- Progressive rendering: onMatch fires per-batch, before the final result -

test("onMatch: fires once per scored candidate, each preview matching its eventual final Match", async () => {
  const previews: Match[] = [];
  const map = await buildOpportunityMap(
    fixtureProfile.description,
    undefined,
    deps({
      // Real per-batch shape: call onBatch once per candidate (as if each were
      // its own batch), handing back THIS batch's own assessments — exactly
      // what the real explainMatches does, unlike the other fixtures in this
      // file (which ignore onBatch entirely).
      explainMatches: async (_p, candidates, _meter, onBatch) => {
        const out = candidates.map((c) => assess(c.id));
        for (let i = 0; i < out.length; i++) {
          onBatch?.([out[i]], i + 1, out.length);
        }
        return out;
      },
    }),
    undefined,
    undefined,
    undefined,
    (m) => previews.push(m),
  );

  assert.equal(previews.length, fixtureCorpus.length, "one preview per scored candidate");
  const previewIds = previews.map((m) => m.opportunity.id).sort();
  const finalIds = map.matches.map((m) => m.opportunity.id).sort();
  assert.deepEqual(previewIds, finalIds, "preview candidates match the final result exactly");
  for (const p of previews) {
    const final = map.matches.find((m) => m.opportunity.id === p.opportunity.id)!;
    assert.equal(p.score, final.score, "a preview's score matches its final score");
    assert.equal(p.tier, final.tier, "a preview's tier matches its final tier");
    // Eligibility/discernment are added AFTER scoring (need the whole scored
    // set / a shared CompanyProfile) — a preview must never carry them, so the
    // UI can't mistake an early, incomplete Match for the fully-assembled one.
    assert.equal(p.eligibility, undefined, "a preview never carries eligibility (added after scoring)");
  }
});

test("onMatch is best-effort: a throwing callback never fails the search or drops candidates", async () => {
  const map = await buildOpportunityMap(
    fixtureProfile.description,
    undefined,
    deps({
      explainMatches: async (_p, candidates, _meter, onBatch) => {
        const out = candidates.map((c) => assess(c.id));
        for (let i = 0; i < out.length; i++) onBatch?.([out[i]], i + 1, out.length);
        return out;
      },
    }),
    undefined,
    undefined,
    undefined,
    () => { throw new Error("preview renderer boom"); },
  );
  assert.equal(map.matches.length, fixtureCorpus.length, "every candidate still lands in the final result");
});

test("onMatch is optional: omitting it changes nothing about the final result", async () => {
  const map = await buildOpportunityMap(fixtureProfile.description, undefined, deps({
    explainMatches: async (_p, candidates, _meter, onBatch) => {
      const out = candidates.map((c) => assess(c.id));
      for (let i = 0; i < out.length; i++) onBatch?.([out[i]], i + 1, out.length);
      return out;
    },
  }));
  assert.equal(map.matches.length, fixtureCorpus.length);
});
