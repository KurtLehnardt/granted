import { test, describe, before, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Isolated config path — see cloudClient.test.ts's comment.
const CONFIG_PATH = path.join(os.tmpdir(), `granted-llm-config-batchsize-test-${process.pid}.json`);

let cloudBatchSize: typeof import("../client").cloudBatchSize;
let writeLlmConfig: typeof import("../config").writeLlmConfig;
let resetLlmConfigCache: typeof import("../config").resetLlmConfigCache;

before(async () => {
  process.env.GRANTED_LLM_CONFIG_PATH = CONFIG_PATH;
  ({ cloudBatchSize } = await import("../client"));
  ({ writeLlmConfig, resetLlmConfigCache } = await import("../config"));
});

const savedProvider = process.env.LLM_PROVIDER;

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
  removeConfigFile();
});

describe("cloudBatchSize — per-preset scoring-batch size", () => {
  test("groq: the free-tier preset's batchSize (2) overrides the hosted default", () => {
    delete process.env.LLM_PROVIDER;
    writeLlmConfig({ provider: "cloud", cloud: { providerId: "groq", model: "llama", keySource: { type: "inline", key: "gsk-groqkeyvalue0000" } } });
    assert.equal(cloudBatchSize(8), 2);
    assert.equal(cloudBatchSize(12), 2);
  });

  test("openrouter and fcc also use 2 per call", () => {
    delete process.env.LLM_PROVIDER;
    writeLlmConfig({ provider: "cloud", cloud: { providerId: "openrouter", model: "m", keySource: { type: "inline", key: "a-reasonable-key-value" } } });
    assert.equal(cloudBatchSize(8), 2);

    writeLlmConfig({ provider: "cloud", cloud: { providerId: "fcc", baseUrl: "http://127.0.0.1:8082", keySource: { type: "inline", key: "a-reasonable-key-value" } } });
    assert.equal(cloudBatchSize(8), 2);
  });

  test("anthropic: no preset override, keeps the caller's hosted default", () => {
    delete process.env.LLM_PROVIDER;
    writeLlmConfig({ provider: "cloud", cloud: { providerId: "anthropic", keySource: { type: "inline", key: "sk-ant-abcXYZ1234567890" } } });
    assert.equal(cloudBatchSize(8), 8);
  });

  test("no saved cloud config: defaults to anthropic, keeps the hosted default", () => {
    delete process.env.LLM_PROVIDER;
    assert.equal(cloudBatchSize(8), 8);
  });
});
