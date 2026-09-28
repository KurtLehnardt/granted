import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";

import { buildOpportunityMap, type BuildDeps } from "../match";
import { assembleTwoPass } from "../scoring/twoPass";
import type { EligibilityDetermination } from "../contracts/eligibilityDetermination";
import type { Opportunity, StartupProfile } from "../types";

/**
 * §1 — every provisional id must be resolved. No card may spin after scoring
 * ends: whatever the cause (Pass A dropping/misnaming an id, a hosted batch
 * failing outright, a pre-excluded candidate, or the model returning an id
 * that matches nothing), the final map must carry an explicit terminal event
 * and a placeholder entry for it.
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

const profile: StartupProfile = { description: "We build sensing hardware.", employees: 20 };

afterEach(() => {
  delete process.env.NEXT_PUBLIC_FLAG_E3_TWO_PASS;
});

function assess(id: string, score = 50) {
  return {
    id, score, tier: "verify" as const, criteria: [],
    whyCare: "", whyFit: "", whyIneligible: "", whatToVerify: "", whatToDoNext: "",
  };
}

async function run(corpus: Opportunity[], deps: Partial<BuildDeps>) {
  const matchEvents: string[] = [];
  const map = await buildOpportunityMap(
    profile.description,
    undefined,
    { corpus, ...deps },
    undefined,
    undefined,
    undefined,
    (m) => matchEvents.push(m.opportunity.id),
    undefined,
  );
  return { map, matchEvents };
}

describe("§1 — every provisional id is resolved", () => {
  test("a candidate the scorer silently drops still gets a terminal event and a place in the final map", async () => {
    const corpus = [opp("kept"), opp("dropped")];
    const { map, matchEvents } = await run(corpus, {
      extractProfile: async () => ({ profile, followUps: [] }),
      embed: async () => QUERY_VEC,
      // Simulates a hosted batch failure / model dropping an id: only "kept" comes back.
      explainMatches: async () => [assess("kept")],
      explainWeakField: async () => ({ headline: "h", reasoning: "r", redirects: [] }),
    });

    assert.ok(matchEvents.includes("dropped"), "a terminal onMatch event fired for the dropped id");
    const dropped = map.matches.find((m) => m.opportunity.id === "dropped");
    assert.ok(dropped, "the dropped candidate is still in the final map");
    assert.equal(dropped!.unscored, true);
    assert.equal(dropped!.final, true);
    assert.equal(dropped!.tier, "none");
  });

  test("the model returning an unknown/misnamed id doesn't leave the real candidate unresolved", async () => {
    const corpus = [opp("real-1")];
    const { map, matchEvents } = await run(corpus, {
      extractProfile: async () => ({ profile, followUps: [] }),
      embed: async () => QUERY_VEC,
      // Model returns a score for an id that matches nothing.
      explainMatches: async () => [assess("typo-id")],
      explainWeakField: async () => ({ headline: "h", reasoning: "r", redirects: [] }),
    });

    assert.ok(matchEvents.includes("real-1"));
    const real = map.matches.find((m) => m.opportunity.id === "real-1");
    assert.ok(real);
    assert.equal(real!.unscored, true);
  });

  test("a pre-excluded candidate is resolved (not marked unscored — it has a real determination)", async () => {
    const corpus = [opp("excluded-1")];
    const determination: EligibilityDetermination = {
      bucket: "excluded",
      failed_rules: [{ rule_id: "r1", description: "Not eligible.", severity: "hard" }],
      passed_rules: [],
      unknown_facts: [],
      required_steps: [],
    } as unknown as EligibilityDetermination;

    const { map } = await run(corpus, {
      extractProfile: async () => ({ profile, followUps: [] }),
      embed: async () => QUERY_VEC,
      explainMatches: async () => [],
      explainWeakField: async () => ({ headline: "h", reasoning: "r", redirects: [] }),
      screen: () => determination,
    });

    const m = map.matches.find((mm) => mm.opportunity.id === "excluded-1");
    assert.ok(m, "a pre-excluded candidate stays in the final map");
    assert.notEqual(m!.unscored, true, "a real determination is not an 'unscored' placeholder");
  });

  test("the two-pass scorer dropping a candidate at Pass A still resolves it", async () => {
    process.env.NEXT_PUBLIC_FLAG_E3_TWO_PASS = "true";
    const corpus = [opp("passA-kept"), opp("passA-dropped")];
    const { map, matchEvents } = await run(corpus, {
      extractProfile: async () => ({ profile, followUps: [] }),
      embed: async () => QUERY_VEC,
      explainMatchesTwoPass: async (_p, candidates, _meter, onBatch, _signal, onAssessment) => {
        // Only score "passA-kept" — mirrors a failed Pass-A batch for the other id.
        const a = assess("passA-kept", 70);
        onAssessment?.({ ...a, final: false });
        onBatch?.(1, candidates.length, { passAScored: 1, promotedCount: 0, passBScored: 0 });
        const finalA = { ...a, final: true };
        onAssessment?.(finalA);
        return [finalA];
      },
      explainWeakField: async () => ({ headline: "h", reasoning: "r", redirects: [] }),
    });

    assert.ok(matchEvents.includes("passA-dropped"));
    const dropped = map.matches.find((m) => m.opportunity.id === "passA-dropped");
    assert.ok(dropped);
    assert.equal(dropped!.unscored, true);
    assert.equal(dropped!.final, true);
  });

  test("two-pass through the REAL assembleTwoPass merge: a Pass-A-dropped id still gets a streamed terminal event, not just a place in the final map", async () => {
    // A mock that returns assembleTwoPass(...)'s own output — exactly what the
    // real explainMatchesTwoPass returns — is the regression case: it puts an
    // `unscored` assessment for "dropped" into the return value WITHOUT ever
    // calling onAssessment for it (Pass A's own callback only fires for ids a
    // batch actually returned). A fix that checks `matches` membership instead
    // of "was actually streamed" wrongly treats this id as already resolved.
    process.env.NEXT_PUBLIC_FLAG_E3_TWO_PASS = "true";
    const corpus = [opp("passA-kept"), opp("passA-dropped")];
    const { map, matchEvents } = await run(corpus, {
      extractProfile: async () => ({ profile, followUps: [] }),
      embed: async () => QUERY_VEC,
      explainMatchesTwoPass: async (_p, candidates, _meter, onBatch, _signal, onAssessment) => {
        const passA = [{ id: "passA-kept", score: 70 }]; // Pass A never returns "passA-dropped" at all.
        for (const s of passA) onAssessment?.({ ...assess(s.id, s.score), final: true });
        onBatch?.(1, candidates.length, { passAScored: 1, promotedCount: 0, passBScored: 0 });
        return assembleTwoPass(candidates.map((c) => c.id), passA, []);
      },
      explainWeakField: async () => ({ headline: "h", reasoning: "r", redirects: [] }),
    });

    assert.ok(matchEvents.includes("passA-dropped"), "onMatch fired for the dropped id, not just 'kept'");
    const dropped = map.matches.find((m) => m.opportunity.id === "passA-dropped");
    assert.ok(dropped);
    assert.equal(dropped!.unscored, true);
    assert.equal(dropped!.final, true);
  });

  test("a pre-excluded candidate gets its terminal event streamed immediately, not just present in the final map", async () => {
    const corpus = [opp("excluded-1"), opp("scored-1")];
    const determination: EligibilityDetermination = {
      bucket: "excluded",
      failed_rules: [{ rule_id: "r1", description: "Not eligible.", severity: "hard" }],
      passed_rules: [],
      unknown_facts: [],
      required_steps: [],
    } as unknown as EligibilityDetermination;

    const { matchEvents } = await run(corpus, {
      extractProfile: async () => ({ profile, followUps: [] }),
      embed: async () => QUERY_VEC,
      explainMatches: async () => [assess("scored-1")],
      explainWeakField: async () => ({ headline: "h", reasoning: "r", redirects: [] }),
      screen: (_profile, o) => (o.id === "excluded-1" ? determination : {
        bucket: "eligible", failed_rules: [], passed_rules: [], unknown_facts: [], required_steps: [],
      } as unknown as EligibilityDetermination),
    });

    assert.ok(matchEvents.includes("excluded-1"), "a terminal onMatch event fired for the pre-excluded id");
  });

  test("a provisional id trimmed from the tail of the profile-scored set is still resolved", async () => {
    // Hermetic repro: "e" and "q0..q2" clear only one of the two retrieval
    // passes; "p" clears both, landing at the tail of the profile-based
    // selection. The old trim cut "p" (neither provisional-only-extra nor
    // preserved) out of `scored` entirely.
    const e: Opportunity = { ...opp("e"), embedding: [1, 0] };
    const p: Opportunity = { ...opp("p"), embedding: [0.97, 0.243] };
    const q = ["q0", "q1", "q2"].map((id) => ({ ...opp(id), embedding: [0, 1] }));
    const corpus = [e, p, ...q];

    let embedCalls = 0;
    const { map, matchEvents } = await run(
      corpus,
      {
        extractProfile: async () => ({ profile, followUps: [] }),
        embed: async () => (++embedCalls === 1 ? [1, 0] : [0, 1]),
        explainMatches: async (_p, candidates) => candidates.map((c) => assess(c.id)),
        explainWeakField: async () => ({ headline: "h", reasoning: "r", redirects: [] }),
      },
    );

    assert.ok(matchEvents.includes("p"), "a terminal onMatch event fired for the trimmed-tail provisional id");
    const resolvedP = map.matches.find((m) => m.opportunity.id === "p");
    assert.ok(resolvedP, "the trimmed-tail provisional id is still in the final map");
  });

  test("the model returning an id that was never a candidate (a real corpus id, just not retrieved) drops it — never streamed, never in the final map", async () => {
    const a: Opportunity = { ...opp("A"), embedding: QUERY_VEC };
    // "B" is a real corpus id, but its embedding is orthogonal to the query
    // (cosine 0 < candidateFloor), so it never clears retrieval and is never
    // a candidate — an assessment id is resolved only against `scored`.
    const b: Opportunity = { ...opp("B"), embedding: [0, 1] };
    const corpus = [a, b];
    const { map, matchEvents } = await run(corpus, {
      extractProfile: async () => ({ profile, followUps: [] }),
      embed: async () => QUERY_VEC,
      // Model hallucinates/returns an assessment for "B", which was never sent to it.
      explainMatches: async () => [assess("B")],
      explainWeakField: async () => ({ headline: "h", reasoning: "r", redirects: [] }),
    });

    assert.ok(!matchEvents.includes("B"), "B must never be streamed — it was never a candidate");
    assert.ok(!map.matches.some((m) => m.opportunity.id === "B"), "B must never appear in the final map");
    const resolvedA = map.matches.find((m) => m.opportunity.id === "A");
    assert.ok(resolvedA, "A is still resolved");
    assert.equal(resolvedA!.unscored, true, "A resolves as unscored since the model never scored it");
    assert.equal(resolvedA!.final, true);
  });

  test("the returned map forces final:true even when a scorer assessment carries final:false", async () => {
    const { map } = await run([opp("x")], {
      extractProfile: async () => ({ profile, followUps: [] }),
      embed: async () => QUERY_VEC,
      explainMatches: async () => [{ ...assess("x", 70), final: false }],
      explainWeakField: async () => ({ headline: "h", reasoning: "r", redirects: [] }),
    });

    const x = map.matches.find((m) => m.opportunity.id === "x");
    assert.equal(x?.score, 70);
    assert.equal(x?.final, true);
  });

  test("no unresolved provisional id remains in the collapsed section's absence — every id has a final Match", async () => {
    const corpus = Array.from({ length: 5 }, (_, i) => opp(`c${i}`));
    const { map } = await run(corpus, {
      extractProfile: async () => ({ profile, followUps: [] }),
      embed: async () => QUERY_VEC,
      explainMatches: async () => [], // scorer returns nothing for anyone
      explainWeakField: async () => ({ headline: "h", reasoning: "r", redirects: [] }),
    });

    const ids = new Set(map.matches.map((m) => m.opportunity.id));
    for (const o of corpus) {
      assert.ok(ids.has(o.id), `${o.id} must still be present in the final map`);
      const m = map.matches.find((mm) => mm.opportunity.id === o.id)!;
      assert.equal(m.final, true, `${o.id} must be marked final — no card may keep spinning`);
    }
  });
});
