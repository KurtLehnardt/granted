import { test, describe, before, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Opportunity, StartupProfile } from "../types";

// #226 — per-preset batch size (next to #225's per-preset concurrency) and
// split-on-413 recovery. Routed through the OpenAI-compat shim (groq/openai
// presets) so the fetch stub can inspect/control batch sizes directly.

const CONFIG_PATH = path.join(os.tmpdir(), `granted-llm-config-freetier-batching-test-${process.pid}.json`);

let explainMatches: typeof import("../claude").explainMatches;
let writeLlmConfig: typeof import("../llm/config").writeLlmConfig;
let resetLlmConfigCache: typeof import("../llm/config").resetLlmConfigCache;

before(async () => {
  process.env.GRANTED_LLM_CONFIG_PATH = CONFIG_PATH;
  ({ explainMatches } = await import("../claude"));
  ({ writeLlmConfig, resetLlmConfigCache } = await import("../llm/config"));
});

const savedProvider = process.env.LLM_PROVIDER;
const savedBatch = process.env.LLM_BATCH_SIZE;
const realFetch = globalThis.fetch;
const realWarn = console.warn;

function removeConfigFile() {
  try {
    fs.unlinkSync(CONFIG_PATH);
  } catch {
    /* already absent */
  }
  resetLlmConfigCache();
}

afterEach(() => {
  if (savedProvider === undefined) delete process.env.LLM_PROVIDER;
  else process.env.LLM_PROVIDER = savedProvider;
  if (savedBatch === undefined) delete process.env.LLM_BATCH_SIZE;
  else process.env.LLM_BATCH_SIZE = savedBatch;
  globalThis.fetch = realFetch;
  console.warn = realWarn;
  removeConfigFile();
});

function opp(id: string): Opportunity {
  return {
    id,
    source: "grants.gov",
    kind: "grant",
    program: `program ${id}`,
    agency: "TestAgency",
    description: `grant ${id}`,
    eligibility: "US small business.",
    embedding: [1, 0],
  };
}

const profile: StartupProfile = { description: "AI sensing hardware for federal customers.", employees: 20 };

/** Pulls the candidate ids the request body actually asked to score: the fetch
 * `body` is the whole chat-completions payload (JSON), whose user message
 * `content` is itself the `CANDIDATE OPPORTUNITIES:` compact-JSON block
 * `explainMatches` builds — so parse the envelope first, then match ids in
 * that (unescaped) content string. */
function idsInRequestBody(body: string): string[] {
  const payload = JSON.parse(body);
  const content: string = payload.messages.find((m: any) => m.role === "user")?.content ?? "";
  const ids: string[] = [];
  const re = /"id":"([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content))) ids.push(m[1]);
  return ids;
}

function assessmentFor(id: string) {
  return { id, score: 80, tier: "likely", criteria: [], whyCare: "c", whyFit: "f", whyIneligible: "", whatToVerify: "v", whatToDoNext: "n" };
}

describe("free-tier batching — per-preset batch size", () => {
  test("groq: 2 candidates per call by default", async () => {
    delete process.env.LLM_PROVIDER;
    delete process.env.LLM_BATCH_SIZE;
    writeLlmConfig({ provider: "cloud", cloud: { providerId: "groq", model: "llama-3.3-70b-versatile", keySource: { type: "inline", key: "gsk-groqkeyvalue0000" } } });

    const groupSizes: number[] = [];
    globalThis.fetch = (async (_url: string, init: any) => {
      const ids = idsInRequestBody(init.body);
      groupSizes.push(ids.length);
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { content: JSON.stringify(ids.map(assessmentFor)) } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }),
      };
    }) as unknown as typeof fetch;

    const candidates = ["a", "b", "c", "d", "e"].map(opp);
    const result = await explainMatches(profile, candidates);

    assert.deepEqual(groupSizes.sort(), [1, 2, 2]);
    assert.equal(result.length, 5);
  });

  test("LLM_BATCH_SIZE env still overrides the groq preset", async () => {
    delete process.env.LLM_PROVIDER;
    process.env.LLM_BATCH_SIZE = "5";
    writeLlmConfig({ provider: "cloud", cloud: { providerId: "groq", model: "llama-3.3-70b-versatile", keySource: { type: "inline", key: "gsk-groqkeyvalue0000" } } });

    const groupSizes: number[] = [];
    globalThis.fetch = (async (_url: string, init: any) => {
      const ids = idsInRequestBody(init.body);
      groupSizes.push(ids.length);
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { content: JSON.stringify(ids.map(assessmentFor)) } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }),
      };
    }) as unknown as typeof fetch;

    const candidates = ["a", "b", "c", "d", "e"].map(opp);
    const result = await explainMatches(profile, candidates);

    assert.deepEqual(groupSizes, [5]);
    assert.equal(result.length, 5);
  });
});

describe("free-tier batching — split on 413 (request too large)", () => {
  test("a multi-candidate 413 splits the batch in half and recovers every candidate", async () => {
    delete process.env.LLM_PROVIDER;
    delete process.env.LLM_BATCH_SIZE; // openai preset: hosted default (8), so all 4 land in one batch
    writeLlmConfig({ provider: "cloud", cloud: { providerId: "openai", model: "gpt-4o-mini", keySource: { type: "inline", key: "sk-openaikeyvalue0000" } } });

    const attempts: number[] = [];
    globalThis.fetch = (async (_url: string, init: any) => {
      const ids = idsInRequestBody(init.body);
      attempts.push(ids.length);
      if (ids.length > 2) return { ok: false, status: 413, text: async () => "Request too large on tokens per minute" };
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { content: JSON.stringify(ids.map(assessmentFor)) } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }),
      };
    }) as unknown as typeof fetch;

    const warnings: string[] = [];
    console.warn = ((...args: unknown[]) => { warnings.push(args.join(" ")); }) as typeof console.warn;

    const candidates = ["a", "b", "c", "d"].map(opp);
    const result = await explainMatches(profile, candidates);

    assert.deepEqual(attempts, [4, 2, 2]); // the 4-batch 413s, then both halves of 2 succeed
    assert.equal(result.length, 4, "every candidate is recovered via the split");
    assert.equal(warnings.length, 0, "no skip warning — the split fully recovered");
  });

  test("a single-candidate 413 is not split further — logged as skipped like today", async () => {
    delete process.env.LLM_PROVIDER;
    delete process.env.LLM_BATCH_SIZE;
    writeLlmConfig({ provider: "cloud", cloud: { providerId: "openai", model: "gpt-4o-mini", keySource: { type: "inline", key: "sk-openaikeyvalue0000" } } });

    globalThis.fetch = (async (_url: string, init: any) => {
      const ids = idsInRequestBody(init.body);
      // "c" alone always 413s (unsplittable); a batch over 2 also 413s (too large); anything else succeeds.
      if (ids.length > 2 || (ids.length === 1 && ids[0] === "c")) {
        return { ok: false, status: 413, text: async () => "Request too large on tokens per minute" };
      }
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { content: JSON.stringify(ids.map(assessmentFor)) } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }),
      };
    }) as unknown as typeof fetch;

    const warnings: string[] = [];
    console.warn = ((...args: unknown[]) => { warnings.push(args.join(" ")); }) as typeof console.warn;

    const candidates = ["a", "b", "c"].map(opp);
    const result = await explainMatches(profile, candidates);

    assert.deepEqual(result.map((a) => a.id).sort(), ["a", "b"], "a and b recover via the split; c stays unscored");
    assert.equal(warnings.length, 1, "exactly one warning for the unsplittable single candidate");
    assert.match(warnings[0], /1 candidate/);
    assert.match(warnings[0], /413/);
  });

  test("a non-413 error is not split — one call, logged skipped as today", async () => {
    delete process.env.LLM_PROVIDER;
    process.env.LLM_BATCH_SIZE = "2"; // two batches of 2
    writeLlmConfig({ provider: "cloud", cloud: { providerId: "openai", model: "gpt-4o-mini", keySource: { type: "inline", key: "sk-openaikeyvalue0000" } } });

    const attempts: number[] = [];
    globalThis.fetch = (async (_url: string, init: any) => {
      const ids = idsInRequestBody(init.body);
      attempts.push(ids.length);
      if (ids.includes("a")) return { ok: false, status: 500, text: async () => "internal error" };
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { content: JSON.stringify(ids.map(assessmentFor)) } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }),
      };
    }) as unknown as typeof fetch;

    const warnings: string[] = [];
    console.warn = ((...args: unknown[]) => { warnings.push(args.join(" ")); }) as typeof console.warn;

    const candidates = ["a", "b", "c", "d"].map(opp);
    const result = await explainMatches(profile, candidates);

    assert.deepEqual(attempts, [2, 2], "no extra split calls for the 500 batch");
    assert.deepEqual(result.map((a) => a.id).sort(), ["c", "d"]);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /2 candidate/);
    assert.match(warnings[0], /500/);
  });
});
