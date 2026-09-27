import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";

import { handleMatchRequest, type MatchDeps } from "../handler";
import { currentLocalModel } from "@/lib/llm/modelContext";
import type { OpportunityMap } from "@/lib/types";

const VALID_DESCRIPTION =
  "We build AI-assisted diagnostics for rural clinics and need federal funding.";

const savedProvider = process.env.LLM_PROVIDER;
const savedModel = process.env.LOCAL_LLM_MODEL;
const realFetch = globalThis.fetch;

afterEach(() => {
  if (savedProvider === undefined) delete process.env.LLM_PROVIDER;
  else process.env.LLM_PROVIDER = savedProvider;
  if (savedModel === undefined) delete process.env.LOCAL_LLM_MODEL;
  else process.env.LOCAL_LLM_MODEL = savedModel;
  globalThis.fetch = realFetch;
});

function post(body: unknown): Request {
  return new Request("http://localhost/api/match", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function readLines(res: Response): Promise<any[]> {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (value) buf += dec.decode(value, { stream: true });
    if (done) break;
  }
  buf += dec.decode();
  return buf.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => JSON.parse(l));
}

const fakeMap = {
  profile: { description: VALID_DESCRIPTION },
  followUps: [],
  summary: { highPotential: 0, fundingIdentified: 0, agencies: 0, closingIn90Days: 0 },
  matches: [],
  agencyIntelligence: [],
} as unknown as OpportunityMap;

function mockOllamaTags() {
  globalThis.fetch = (async () => ({
    ok: true,
    json: async () => ({
      models: [
        { name: "gemma3:12b", details: { parameter_size: "12B" } },
        { name: "qwen2.5:7b", details: { parameter_size: "7B" } },
      ],
    }),
  })) as unknown as typeof fetch;
}

describe("/api/match local model selection", () => {
  test("hosted: llm.local is false and Ollama is never called, regardless of body.model", async () => {
    delete process.env.LLM_PROVIDER;
    let fetched = false;
    globalThis.fetch = (async () => { fetched = true; return { ok: true, json: async () => ({}) }; }) as unknown as typeof fetch;

    const deps: MatchDeps = {
      cached: () => undefined,
      buildOpportunityMap: async (_d, onStep) => {
        onStep?.({ key: "start", label: "start", pct: 5 });
        return fakeMap;
      },
    };
    const res = await handleMatchRequest(post({ description: VALID_DESCRIPTION, model: "gemma3:12b" }), deps);
    const lines = await readLines(res);
    const start = lines.find((l) => l.type === "progress" && l.key === "start");
    assert.deepEqual(start.llm, { local: false });
    assert.equal(fetched, false);
  });

  test("local: an installed model in body.model is honored and reflected in llm.model", async () => {
    process.env.LLM_PROVIDER = "ollama";
    process.env.LOCAL_LLM_MODEL = "gemma3:12b";
    mockOllamaTags();

    const deps: MatchDeps = {
      cached: () => undefined,
      buildOpportunityMap: async (_d, onStep) => {
        onStep?.({ key: "start", label: "start", pct: 5 });
        return fakeMap;
      },
    };
    const res = await handleMatchRequest(post({ description: VALID_DESCRIPTION, model: "qwen2.5:7b" }), deps);
    const lines = await readLines(res);
    const start = lines.find((l) => l.type === "progress" && l.key === "start");
    assert.equal(start.llm.local, true);
    assert.equal(start.llm.model, "qwen2.5:7b");
    assert.equal(start.llm.paramsB, 7);
  });

  test("local: an unrecognized body.model falls back to LOCAL_LLM_MODEL", async () => {
    process.env.LLM_PROVIDER = "ollama";
    process.env.LOCAL_LLM_MODEL = "gemma3:12b";
    mockOllamaTags();

    const deps: MatchDeps = {
      cached: () => undefined,
      buildOpportunityMap: async (_d, onStep) => {
        onStep?.({ key: "start", label: "start", pct: 5 });
        return fakeMap;
      },
    };
    const res = await handleMatchRequest(post({ description: VALID_DESCRIPTION, model: "not-installed:1b" }), deps);
    const lines = await readLines(res);
    const start = lines.find((l) => l.type === "progress" && l.key === "start");
    assert.equal(start.llm.model, "gemma3:12b");
    assert.equal(start.llm.paramsB, 12);
  });

  test("local: the resolved model is threaded via AsyncLocalStorage for every LLM call in the request", async () => {
    process.env.LLM_PROVIDER = "ollama";
    process.env.LOCAL_LLM_MODEL = "gemma3:12b";
    mockOllamaTags();

    let seenDuringBuild: string | undefined;
    const deps: MatchDeps = {
      cached: () => undefined,
      buildOpportunityMap: async () => {
        seenDuringBuild = currentLocalModel();
        return fakeMap;
      },
    };
    const res = await handleMatchRequest(post({ description: VALID_DESCRIPTION, model: "qwen2.5:7b" }), deps);
    await readLines(res);
    assert.equal(seenDuringBuild, "qwen2.5:7b");
  });
});
