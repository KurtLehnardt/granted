import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { buildOpportunityMap, type BuildDeps } from "../match";
import type { Opportunity, StartupProfile } from "../types";

/**
 * Instant cards (retrieval/profile parallelization) — hermetic, no network.
 *
 * Proves the two load-bearing guarantees the task requires:
 *  (a) retrieval (embedding + BM25/cosine candidate selection) runs WITHOUT
 *      waiting for `extractProfile` to resolve — provisional events fire even
 *      while profile extraction is still pending;
 *  (b) provisional events for every retrieved candidate are emitted strictly
 *      BEFORE the LLM scorer (`explainMatches`/`explainMatchesTwoPass`) is
 *      ever called, using a scorer stub that blocks until released.
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

const corpus: Opportunity[] = [opp("opp-1"), opp("opp-2"), opp("opp-3")];
const profile: StartupProfile = { description: "We build sensing hardware.", employees: 20 };

/** A promise you can resolve from outside, to control exactly when a deferred call settles. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

function assess(id: string) {
  return {
    id, score: 50, tier: "verify" as const, criteria: [],
    whyCare: "", whyFit: "", whyIneligible: "", whatToVerify: "", whatToDoNext: "",
  };
}

describe("instant cards", () => {
  test("provisional events fire for every retrieved candidate while extractProfile is still pending", async () => {
    const profileGate = deferred<{ profile: StartupProfile; followUps: string[] }>();
    const provisionalIds: string[] = [];
    let profileResolved = false;

    const deps: Partial<BuildDeps> = {
      corpus,
      extractProfile: async () => {
        const r = await profileGate.promise;
        profileResolved = true;
        return r;
      },
      embed: async () => QUERY_VEC,
      explainMatches: async (_p, candidates) => candidates.map((c) => assess(c.id)),
      explainWeakField: async () => ({ headline: "h", reasoning: "r", redirects: [] }),
    };

    const mapPromise = buildOpportunityMap(
      profile.description,
      undefined,
      deps,
      undefined,
      undefined,
      undefined,
      undefined,
      (o) => provisionalIds.push(o.id),
    );

    // Give retrieval (embed + BM25/cosine, all synchronous/microtask work) a
    // chance to run while extractProfile is still gated.
    await new Promise((r) => setImmediate(r));

    assert.equal(profileResolved, false, "profile must still be pending at this point");
    assert.deepEqual(
      provisionalIds.sort(),
      ["opp-1", "opp-2", "opp-3"],
      "every retrieved candidate got a provisional event before the profile resolved",
    );

    profileGate.resolve({ profile, followUps: [] });
    await mapPromise;
  });

  test("provisional events for all candidates are emitted strictly before the LLM scorer is ever called", async () => {
    const events: string[] = [];
    const scorerGate = deferred<void>();

    const deps: Partial<BuildDeps> = {
      corpus,
      extractProfile: async () => ({ profile, followUps: [] }),
      embed: async () => QUERY_VEC,
      explainMatches: async (_p, candidates) => {
        events.push("scorer-called");
        await scorerGate.promise; // blocks until released — proves nothing races past provisional events
        return candidates.map((c) => assess(c.id));
      },
      explainWeakField: async () => ({ headline: "h", reasoning: "r", redirects: [] }),
    };

    const mapPromise = buildOpportunityMap(
      profile.description,
      undefined,
      deps,
      undefined,
      undefined,
      undefined,
      undefined,
      (o) => events.push(`provisional:${o.id}`),
    );

    // Let everything up to (and including) the blocked scorer call settle.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    const scorerIdx = events.indexOf("scorer-called");
    assert.ok(scorerIdx > 0, "the scorer must have been reached");
    const provisionalEvents = events.slice(0, scorerIdx);
    assert.equal(provisionalEvents.length, 3, "all 3 candidates got a provisional event before the scorer ran");
    assert.ok(provisionalEvents.every((e) => e.startsWith("provisional:")));

    scorerGate.resolve();
    await mapPromise;
  });
});
