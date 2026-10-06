import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { buildOpportunityMap, CALIBRATION, type BuildDeps } from "../match";
import type { EmbedOptions } from "../embed";
import type { Opportunity } from "../types";
import { resetLlmConfigCache } from "../llm/config";

/**
 * One decision for corpus + query embedding: buildOpportunityMap loads the corpus
 * once (in the active embedding space) and embeds the query in THAT corpus's
 * space, and uses that space's similarity floor.
 */

const ENV_KEYS = ["OPENAI_API_KEY", "EMBEDDINGS_API_KEY", "SEARCH_EMBEDDINGS", "EMBEDDINGS_BASE_URL", "LLM_PROVIDER"] as const;
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  resetLlmConfigCache();
});

async function spaceUsedBySearch(): Promise<EmbedOptions["space"]> {
  let seen: EmbedOptions | undefined;
  await assert.rejects(
    buildOpportunityMap("We build sensing hardware.", undefined, {
      extractProfile: async () => ({ profile: { description: "x" }, followUps: [] }) as any,
      embed: (async (_t: string, _m: unknown, _s: unknown, opts?: EmbedOptions) => {
        seen = opts;
        throw new Error("stop after the first embed");
      }) as any,
    }),
    /stop after the first embed/,
  );
  return seen?.space;
}

describe("buildOpportunityMap — the query is embedded in the loaded corpus's space", () => {
  test("no OpenAI key (e.g. a Claude-only setup) -> the built-in space", async () => {
    for (const k of ENV_KEYS) delete process.env[k];
    const space = await spaceUsedBySearch();
    assert.equal(space?.id, "builtin");
    assert.equal(space?.backend, "inprocess");
  });

  test("a valid OpenAI key -> OpenAI, exactly as before", async () => {
    for (const k of ENV_KEYS) delete process.env[k];
    process.env.OPENAI_API_KEY = "sk-proj-abcdefghijklmnopqrstuvwxyz1234567890";
    const space = await spaceUsedBySearch();
    assert.equal(space?.id, "openai");
  });

  test("SEARCH_EMBEDDINGS=builtin wins over an OpenAI key", async () => {
    for (const k of ENV_KEYS) delete process.env[k];
    process.env.OPENAI_API_KEY = "sk-proj-abcdefghijklmnopqrstuvwxyz1234567890";
    process.env.SEARCH_EMBEDDINGS = "builtin";
    const space = await spaceUsedBySearch();
    assert.equal(space?.id, "builtin");
  });
});

describe("buildOpportunityMap — per-space similarity floor", () => {
  const opp = (id: string, embedding: number[]): Opportunity => ({
    id,
    source: "grants.gov",
    kind: "grant",
    program: `Program ${id}`,
    agency: "NSF",
    description: "Research.",
    eligibility: "Anyone.",
    embedding,
  });
  // cosine with [1, 0] is 0.9 for "near" and 0.35 for "middling".
  const corpus = [opp("near", [0.9, Math.sqrt(1 - 0.81)]), opp("middling", [0.35, Math.sqrt(1 - 0.35 * 0.35)])];

  async function scoredIds(space?: BuildDeps["space"]): Promise<string[]> {
    let ids: string[] = [];
    await buildOpportunityMap("We do research.", undefined, {
      corpus,
      space,
      extractProfile: async () => ({ profile: { description: "x" }, followUps: [] }) as any,
      embed: (async () => [1, 0]) as any,
      explainMatches: (async (_p: unknown, candidates: Opportunity[]) => {
        ids = candidates.map((c) => c.id).sort();
        return candidates.map((c) => ({ id: c.id, score: 10, tier: "none", criteria: [], whyCare: "", whyFit: "", whyIneligible: "", whatToVerify: "", whatToDoNext: "" }));
      }) as any,
      explainWeakField: async () => ({ headline: "h", reasoning: "r", redirects: [] }),
    });
    return ids;
  }

  test("an injected corpus without a space keeps CALIBRATION's (OpenAI) floor", async () => {
    assert.equal(CALIBRATION.candidateFloor, 0.22);
    assert.deepEqual(await scoredIds(), ["middling", "near"]);
  });

  test("a space with a higher floor drops what falls below it", async () => {
    assert.deepEqual(await scoredIds({ candidateFloor: 0.5, weakFieldThreshold: 1 }), ["near"]);
  });
});
