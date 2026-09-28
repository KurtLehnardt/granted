import { test, describe, before, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EMBEDDINGS_IS_OPENAI } from "@/lib/embed";

const CONFIG_PATH = path.join(os.tmpdir(), `granted-llm-config-route-test-${process.pid}.json`);

let GET: typeof import("../route").GET;
let dynamic: typeof import("../route").dynamic;
let writeLlmConfig: typeof import("@/lib/llm/config").writeLlmConfig;
let resetLlmConfigCache: typeof import("@/lib/llm/config").resetLlmConfigCache;

before(async () => {
  process.env.GRANTED_LLM_CONFIG_PATH = CONFIG_PATH;
  ({ GET, dynamic } = await import("../route"));
  ({ writeLlmConfig, resetLlmConfigCache } = await import("@/lib/llm/config"));
});

const savedProvider = process.env.LLM_PROVIDER;
const savedModel = process.env.LOCAL_LLM_MODEL;
const savedKey = process.env.ANTHROPIC_API_KEY;
const realFetch = globalThis.fetch;

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
  if (savedModel === undefined) delete process.env.LOCAL_LLM_MODEL;
  else process.env.LOCAL_LLM_MODEL = savedModel;
  if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = savedKey;
  globalThis.fetch = realFetch;
  removeConfigFile();
});

describe("GET /api/llm", () => {
  test("opts out of static prerendering", () => {
    assert.equal(dynamic, "force-dynamic");
  });

  test("hosted (env ANTHROPIC_API_KEY, #210 back-compat) -> cloud/anthropic, key hint, no key value", async () => {
    delete process.env.LLM_PROVIDER;
    process.env.ANTHROPIC_API_KEY = "sk-ant-abcd1234efgh5678";
    let fetched = false;
    globalThis.fetch = (async () => { fetched = true; return { ok: true, json: async () => ({}) }; }) as unknown as typeof fetch;

    const res = await GET();
    const j = await res.json();
    assert.equal(j.local, false);
    assert.equal(j.provider, "cloud");
    assert.equal(j.cloud.providerId, "anthropic");
    assert.equal(j.cloud.hasKey, true);
    assert.equal(j.cloud.keyHint, "5678");
    assert.deepEqual(j.cloud.keySource, { type: "env", name: "ANTHROPIC_API_KEY" });
    assert.equal(JSON.stringify(j).includes("sk-ant-abcd1234efgh5678"), false);
    assert.equal(j.openAiEmbeddings, EMBEDDINGS_IS_OPENAI);
    assert.equal(fetched, false, "hosted must never call Ollama");
  });

  test("hosted with no key anywhere -> no cloud block", async () => {
    delete process.env.LLM_PROVIDER;
    delete process.env.ANTHROPIC_API_KEY;

    const res = await GET();
    const j = await res.json();
    assert.equal(j.local, false);
    assert.equal(j.cloud, undefined);
  });

  test("hosted with .env.example placeholder key -> no cloud block", async () => {
    delete process.env.LLM_PROVIDER;
    process.env.ANTHROPIC_API_KEY = "sk-ant-...";

    const res = await GET();
    const j = await res.json();
    assert.equal(j.cloud, undefined);
  });

  test("saved cloud config (non-anthropic) reports providerId, model, and key source, never the key", async () => {
    delete process.env.LLM_PROVIDER;
    writeLlmConfig({
      provider: "cloud",
      cloud: { providerId: "openai", model: "gpt-4o", keySource: { type: "inline", key: "sk-savedopenaikey0000" } },
    });

    const res = await GET();
    const j = await res.json();
    assert.equal(j.provider, "cloud");
    assert.equal(j.cloud.providerId, "openai");
    assert.equal(j.cloud.model, "gpt-4o");
    assert.equal(j.cloud.hasKey, true);
    assert.equal(j.cloud.keyHint, "0000");
    assert.deepEqual(j.cloud.keySource, { type: "inline" });
    assert.equal(JSON.stringify(j).includes("sk-savedopenaikey0000"), false);
  });

  test("'other' provider reports its base URL", async () => {
    delete process.env.LLM_PROVIDER;
    writeLlmConfig({
      provider: "cloud",
      cloud: { providerId: "other", baseUrl: "https://my-proxy.example.com/v1", keySource: { type: "inline", key: "any-fine-key-value" } },
    });
    const res = await GET();
    const j = await res.json();
    assert.equal(j.cloud.baseUrl, "https://my-proxy.example.com/v1");
  });

  test("cloud key sourced from an unset env var -> hasKey: false, no hint", async () => {
    delete process.env.LLM_PROVIDER;
    delete process.env.GRANTED_ROUTE_TEST_UNSET;
    writeLlmConfig({ provider: "cloud", cloud: { providerId: "groq", keySource: { type: "env", name: "GRANTED_ROUTE_TEST_UNSET" } } });
    const res = await GET();
    const j = await res.json();
    assert.equal(j.cloud.hasKey, false);
    assert.equal(j.cloud.keyHint, undefined);
    assert.deepEqual(j.cloud.keySource, { type: "env", name: "GRANTED_ROUTE_TEST_UNSET" });
  });

  test("local -> a saved cloud config still reports its cloud block (so Settings can show/remove it)", async () => {
    writeLlmConfig({
      provider: "ollama",
      cloud: { providerId: "openai", model: "gpt-4o", keySource: { type: "inline", key: "sk-savedopenaikey0000" } },
    });
    globalThis.fetch = (async () => ({ ok: true, json: async () => ({ models: [] }) })) as unknown as typeof fetch;

    const res = await GET();
    const j = await res.json();
    assert.equal(j.local, true);
    assert.equal(j.cloud.providerId, "openai");
    assert.equal(j.cloud.hasKey, true);
  });

  test("local -> no saved cloud config -> no cloud block", async () => {
    process.env.LLM_PROVIDER = "ollama";
    globalThis.fetch = (async () => ({ ok: true, json: async () => ({ models: [] }) })) as unknown as typeof fetch;

    const res = await GET();
    const j = await res.json();
    assert.equal(j.cloud, undefined);
  });

  test("saved cloud config with no explicit model -> the response omits `model` (never the provider default)", async () => {
    delete process.env.LLM_PROVIDER;
    writeLlmConfig({
      provider: "cloud",
      cloud: { providerId: "openai", keySource: { type: "inline", key: "sk-savedopenaikey0000" } },
    });

    const res = await GET();
    const j = await res.json();
    assert.equal(j.cloud.model, undefined);
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
