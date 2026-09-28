import { test, describe, before, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Isolated config path — see config.test.ts's comment.
const CONFIG_PATH = path.join(os.tmpdir(), `granted-llm-config-cloudclient-test-${process.pid}.json`);

let makeLlmClient: typeof import("../client").makeLlmClient;
let writeLlmConfig: typeof import("../config").writeLlmConfig;
let resetLlmConfigCache: typeof import("../config").resetLlmConfigCache;

before(async () => {
  process.env.GRANTED_LLM_CONFIG_PATH = CONFIG_PATH;
  ({ makeLlmClient } = await import("../client"));
  ({ writeLlmConfig, resetLlmConfigCache } = await import("../config"));
});

const realFetch = globalThis.fetch;
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
  globalThis.fetch = realFetch;
  if (savedProvider === undefined) delete process.env.LLM_PROVIDER;
  else process.env.LLM_PROVIDER = savedProvider;
  removeConfigFile();
});

describe("makeLlmClient — cloud provider routing (non-anthropic, OpenAI-compat shim)", () => {
  test("openai: preset base URL, bearer key, chosen model", async () => {
    delete process.env.LLM_PROVIDER;
    writeLlmConfig({
      provider: "cloud",
      cloud: { providerId: "openai", model: "gpt-4o", keySource: { type: "inline", key: "sk-openaikeyvalue0000" } },
    });
    let sentUrl = "";
    let sentAuth = "";
    let sentBody: any;
    globalThis.fetch = (async (url: string, init: any) => {
      sentUrl = url;
      sentAuth = init.headers.Authorization;
      sentBody = JSON.parse(init.body);
      return { ok: true, json: async () => ({ choices: [{ message: { content: "{}" } }], usage: {} }) };
    }) as unknown as typeof fetch;

    const client = makeLlmClient({ timeout: 5000 });
    await client.messages.create({ model: "ignored", max_tokens: 10, messages: [{ role: "user", content: "hi" }] });

    assert.equal(sentUrl, "https://api.openai.com/v1/chat/completions");
    assert.equal(sentAuth, "Bearer sk-openaikeyvalue0000");
    assert.equal(sentBody.model, "gpt-4o");
  });

  test("groq: preset base URL", async () => {
    delete process.env.LLM_PROVIDER;
    writeLlmConfig({
      provider: "cloud",
      cloud: { providerId: "groq", model: "llama-3.3-70b-versatile", keySource: { type: "inline", key: "gsk-groqkeyvalue0000" } },
    });
    let sentUrl = "";
    globalThis.fetch = (async (url: string) => {
      sentUrl = url;
      return { ok: true, json: async () => ({ choices: [{ message: { content: "{}" } }], usage: {} }) };
    }) as unknown as typeof fetch;

    await makeLlmClient({ timeout: 5000 }).messages.create({ model: "ignored", max_tokens: 10, messages: [{ role: "user", content: "hi" }] });
    assert.equal(sentUrl, "https://api.groq.com/openai/v1/chat/completions");
  });

  test("'other': the user-entered base URL is used", async () => {
    delete process.env.LLM_PROVIDER;
    writeLlmConfig({
      provider: "cloud",
      cloud: { providerId: "other", baseUrl: "https://my-proxy.example.com/v1", model: "custom-model", keySource: { type: "inline", key: "any-fine-key-value" } },
    });
    let sentUrl = "";
    globalThis.fetch = (async (url: string) => {
      sentUrl = url;
      return { ok: true, json: async () => ({ choices: [{ message: { content: "{}" } }], usage: {} }) };
    }) as unknown as typeof fetch;

    await makeLlmClient({ timeout: 5000 }).messages.create({ model: "ignored", max_tokens: 10, messages: [{ role: "user", content: "hi" }] });
    assert.equal(sentUrl, "https://my-proxy.example.com/v1/chat/completions");
  });

  test("env-sourced key: the resolved value (not the var name) is sent as the bearer token", async () => {
    delete process.env.LLM_PROVIDER;
    process.env.GRANTED_CLOUD_CLIENT_TEST_KEY = "sk-fromenvvaluevalu00";
    writeLlmConfig({ provider: "cloud", cloud: { providerId: "openai", model: "gpt-4o", keySource: { type: "env", name: "GRANTED_CLOUD_CLIENT_TEST_KEY" } } });
    let sentAuth = "";
    globalThis.fetch = (async (_url: string, init: any) => {
      sentAuth = init.headers.Authorization;
      return { ok: true, json: async () => ({ choices: [{ message: { content: "{}" } }], usage: {} }) };
    }) as unknown as typeof fetch;

    await makeLlmClient({ timeout: 5000 }).messages.create({ model: "ignored", max_tokens: 10, messages: [{ role: "user", content: "hi" }] });
    assert.equal(sentAuth, "Bearer sk-fromenvvaluevalu00");
    delete process.env.GRANTED_CLOUD_CLIENT_TEST_KEY;
  });

  test("missing key -> throws the resolver's specific error, no fetch made", async () => {
    delete process.env.LLM_PROVIDER;
    delete process.env.GRANTED_CLOUD_CLIENT_TEST_UNSET;
    writeLlmConfig({ provider: "cloud", cloud: { providerId: "openai", model: "gpt-4o", keySource: { type: "env", name: "GRANTED_CLOUD_CLIENT_TEST_UNSET" } } });
    let fetched = false;
    globalThis.fetch = (async () => { fetched = true; return { ok: true, json: async () => ({}) }; }) as unknown as typeof fetch;

    assert.throws(() => makeLlmClient({ timeout: 5000 }), /isn't set/);
    assert.equal(fetched, false);
  });
});

describe("makeLlmClient — anthropic cloud path", () => {
  test("no model override: leaves the call site's model untouched", async () => {
    delete process.env.LLM_PROVIDER;
    writeLlmConfig({ provider: "cloud", cloud: { providerId: "anthropic", keySource: { type: "inline", key: "sk-ant-abcXYZ1234567890" } } });
    const client = makeLlmClient({ timeout: 5000 }) as any;
    // Anthropic() constructs a real SDK client; we only assert it doesn't throw and exposes messages.create.
    assert.equal(typeof client.messages.create, "function");
  });

  test("with a saved model: overrides whatever model the call site passes", async () => {
    delete process.env.LLM_PROVIDER;
    writeLlmConfig({ provider: "cloud", cloud: { providerId: "anthropic", model: "claude-haiku-4-5", keySource: { type: "inline", key: "sk-ant-abcXYZ1234567890" } } });
    let sentModel = "";
    // The Anthropic SDK reads its fetch impl from AsyncLocalStorage via withHostedFetch in client.ts;
    // exercise the override wrapper directly instead of stubbing the whole SDK transport.
    const { withHostedFetch } = await import("../client");
    await withHostedFetch((async (_url: any, init: any) => {
      sentModel = JSON.parse(init.body).model;
      return new Response(JSON.stringify({ id: "x", content: [{ type: "text", text: "ok" }], usage: {} }), { status: 200 });
    }) as any, async () => {
      const client = makeLlmClient({ timeout: 5000 });
      await client.messages.create({ model: "claude-sonnet-4-6", max_tokens: 5, messages: [{ role: "user", content: "hi" }] });
    });
    assert.equal(sentModel, "claude-haiku-4-5");
  });
});
