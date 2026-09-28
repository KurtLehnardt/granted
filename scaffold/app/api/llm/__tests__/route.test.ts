import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { GET, dynamic } from "../route";

const savedProvider = process.env.LLM_PROVIDER;
const savedModel = process.env.LOCAL_LLM_MODEL;
const savedKey = process.env.ANTHROPIC_API_KEY;
const realFetch = globalThis.fetch;

afterEach(() => {
  if (savedProvider === undefined) delete process.env.LLM_PROVIDER;
  else process.env.LLM_PROVIDER = savedProvider;
  if (savedModel === undefined) delete process.env.LOCAL_LLM_MODEL;
  else process.env.LOCAL_LLM_MODEL = savedModel;
  if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = savedKey;
  globalThis.fetch = realFetch;
});

describe("GET /api/llm", () => {
  test("opts out of static prerendering", () => {
    assert.equal(dynamic, "force-dynamic");
  });

  test("hosted -> { local: false, provider, hasAnthropicKey }, no Ollama call", async () => {
    delete process.env.LLM_PROVIDER;
    process.env.ANTHROPIC_API_KEY = "sk-ant-abcd1234efgh5678";
    let fetched = false;
    globalThis.fetch = (async () => { fetched = true; return { ok: true, json: async () => ({}) }; }) as unknown as typeof fetch;

    const res = await GET();
    const j = await res.json();
    assert.deepEqual(j, {
      local: false,
      provider: "anthropic",
      hasAnthropicKey: true,
      anthropicKeyHint: "5678",
      anthropicKeySource: "env",
    });
    assert.equal(fetched, false, "hosted must never call Ollama");
  });

  test("hosted with no key -> hasAnthropicKey: false, no hint", async () => {
    delete process.env.LLM_PROVIDER;
    delete process.env.ANTHROPIC_API_KEY;

    const res = await GET();
    const j = await res.json();
    assert.equal(j.hasAnthropicKey, false);
    assert.equal(j.anthropicKeyHint, undefined);
    assert.equal(j.anthropicKeySource, undefined);
  });

  test("hosted with .env.example placeholder key -> hasAnthropicKey: false, no hint", async () => {
    delete process.env.LLM_PROVIDER;
    process.env.ANTHROPIC_API_KEY = "sk-ant-...";

    const res = await GET();
    const j = await res.json();
    assert.equal(j.hasAnthropicKey, false);
    assert.equal(j.anthropicKeyHint, undefined);
    assert.equal(j.anthropicKeySource, undefined);
  });

  test("local -> active model + installed chat models (embedding models excluded)", async () => {
    process.env.LLM_PROVIDER = "ollama";
    process.env.LOCAL_LLM_MODEL = "gemma3:12b";
    globalThis.fetch = (async () => ({
      ok: true,
      json: async () => ({
        models: [
          { name: "gemma3:12b", details: { parameter_size: "12B" } },
          { name: "nomic-embed-text", details: { parameter_size: "137M" } },
        ],
      }),
    })) as unknown as typeof fetch;

    const res = await GET();
    const j = await res.json();
    assert.equal(j.local, true);
    assert.equal(j.model, "gemma3:12b");
    assert.deepEqual(j.models, [{ name: "gemma3:12b", paramsB: 12 }]);
  });
});
