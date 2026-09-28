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
