import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { buildOpportunityMap, type BuildDeps, type StepEvent } from "../match";
import { OpportunityMapSchema } from "../contracts/opportunityMap";
import type { Opportunity } from "../types";

/**
 * When the built-in search model can't be downloaded or loaded, a search falls
 * back to keyword (BM25) retrieval and says so, instead of failing. Other
 * spaces (OpenAI, a custom embedder) still fail loudly on an embedding error.
 */

const opp = (id: string, kind: string, program: string, description: string): Opportunity => ({
  id,
  source: "grants.gov",
  kind: kind as Opportunity["kind"],
  program,
  agency: "EPA",
  description,
  eligibility: "Small businesses.",
});

const corpus: Opportunity[] = [
  opp("water", "grant", "Drinking Water Contaminant Sensors", "Funding for sensors that detect drinking water contamination in rural utilities."),
  opp("soil", "grant", "Soil Health Research", "Research on soil microbiomes and crop yields."),
  opp("sbir", "rd", "SBIR Water Monitoring Topic", "Small business research on water quality monitoring sensors."),
];

function deps(over: Partial<BuildDeps>, sent: { ids: string[] }): Partial<BuildDeps> {
  return {
    corpus,
    extractProfile: async () => ({ profile: { description: "water contamination sensors for rural utilities" }, followUps: [] }) as any,
    explainMatches: (async (_p: unknown, candidates: Opportunity[]) => {
      sent.ids = candidates.map((c) => c.id).sort();
      return candidates.map((c) => ({ id: c.id, score: 50, tier: "verify", criteria: [], whyCare: "w", whyFit: "f", whyIneligible: "", whatToVerify: "", whatToDoNext: "" }));
    }) as any,
    explainMatchesTwoPass: (async (_p: unknown, candidates: Opportunity[]) => {
      sent.ids = candidates.map((c) => c.id).sort();
      return candidates.map((c) => ({ id: c.id, score: 50, tier: "verify", criteria: [], whyCare: "w", whyFit: "f", whyIneligible: "", whatToVerify: "", whatToDoNext: "" }));
    }) as any,
    explainWeakField: async () => ({ headline: "h", reasoning: "r", redirects: [] }),
    ...over,
  };
}

const builtinSpace = { candidateFloor: 0.53, weakFieldThreshold: 1, backend: "inprocess" as const };
const failingEmbed = (async () => {
  throw new Error("couldn't download the search model (fetch failed)");
}) as any;

describe("built-in model unavailable -> keyword-only search", () => {
  test("the search still runs, on BM25, and the map carries the notice", async () => {
    const sent = { ids: [] as string[] };
    const steps: StepEvent[] = [];
    const map = await buildOpportunityMap("Water contamination sensors for rural utilities.", (e) => steps.push(e), deps({ space: builtinSpace, embed: failingEmbed }, sent));
    assert.deepEqual(map.searchNotice, {
      kind: "keyword_only",
      message: "Search is running in keyword-only mode: couldn't download the search model (fetch failed)",
    });
    assert.ok(sent.ids.includes("water") && sent.ids.includes("sbir"), `keyword matches reach scoring: ${sent.ids}`);
    assert.ok(map.matches.length > 0);
    assert.ok(steps.some((s) => s.key === "keyword-only" && /keyword-only mode/.test(s.label)), "the progress stream says so too");
    assert.equal(OpportunityMapSchema.safeParse(map).success, true, "the notice is part of the contract");
  });

  test("the model is only tried once per search: after it fails, no second embedding attempt", async () => {
    let calls = 0;
    const embed = (async () => {
      calls++;
      throw new Error("model won't load");
    }) as any;
    await buildOpportunityMap("Water sensors.", undefined, deps({ space: builtinSpace, embed }, { ids: [] }));
    assert.equal(calls, 1);
  });

  test("OpenAI (an HTTP space) still fails loudly on an embedding error", async () => {
    await assert.rejects(
      buildOpportunityMap("Water sensors.", undefined, deps({ space: { candidateFloor: 0.22, weakFieldThreshold: 1, backend: "http" }, embed: failingEmbed }, { ids: [] })),
      /fetch failed/,
    );
  });

  test("a normal built-in search carries no notice", async () => {
    const map = await buildOpportunityMap(
      "Water sensors.",
      undefined,
      deps({ space: builtinSpace, embed: (async () => [1, 0]) as any, corpus: corpus.map((o) => ({ ...o, embedding: [1, 0] })) }, { ids: [] }),
    );
    assert.equal(map.searchNotice, undefined);
  });
});
