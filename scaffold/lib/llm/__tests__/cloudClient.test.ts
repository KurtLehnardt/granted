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

  test("openai reasoning models: retries with max_completion_tokens and no temperature when rejected", async () => {
    delete process.env.LLM_PROVIDER;
    writeLlmConfig({ provider: "cloud", cloud: { providerId: "openai", model: "gpt-5-mini", keySource: { type: "inline", key: "sk-openaikeyvalue0000" } } });
    const bodies: any[] = [];
    globalThis.fetch = (async (_url: string, init: any) => {
      const body = JSON.parse(init.body);
      bodies.push(body);
      if ("max_tokens" in body) {
        return { ok: false, status: 400, text: async () => "Unsupported parameter: 'max_tokens'. Use 'max_completion_tokens' instead." };
      }
      if ("temperature" in body) {
        return { ok: false, status: 400, text: async () => "Unsupported value: 'temperature' does not support 0 with this model." };
      }
      return { ok: true, json: async () => ({ choices: [{ message: { content: "{}" } }], usage: {} }) };
    }) as unknown as typeof fetch;

    const out: any = await makeLlmClient({ timeout: 5000 }).messages.create({ model: "ignored", max_tokens: 10, messages: [{ role: "user", content: "hi" }] });
    assert.equal(out.content[0].text, "{}");
    assert.equal(bodies.length, 3);
    assert.equal(bodies[2].max_completion_tokens, 10);
    assert.equal("temperature" in bodies[2], false);
  });

  test("an unrelated 400 is not retried and surfaces the provider's message", async () => {
    delete process.env.LLM_PROVIDER;
    writeLlmConfig({ provider: "cloud", cloud: { providerId: "openai", model: "gpt-4o", keySource: { type: "inline", key: "sk-openaikeyvalue0000" } } });
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return { ok: false, status: 400, text: async () => "The model `nope` does not exist" };
    }) as unknown as typeof fetch;

    await assert.rejects(
      makeLlmClient({ timeout: 5000 }).messages.create({ model: "ignored", max_tokens: 10, messages: [{ role: "user", content: "hi" }] }),
      /does not exist/,
    );
    assert.equal(calls, 1);
  });

  test("a provider 4xx body echoing the key is redacted before it becomes a ProviderHttpError", async () => {
    delete process.env.LLM_PROVIDER;
    const key = "gsk_EchoedKey0123456789abcdef";
    writeLlmConfig({ provider: "cloud", cloud: { providerId: "groq", model: "llama", keySource: { type: "inline", key } } });
    globalThis.fetch = (async () => ({ ok: false, status: 401, text: async () => `Invalid key ${key}` })) as unknown as typeof fetch;

    const err: any = await makeLlmClient({ timeout: 5000 })
      .messages.create({ model: "ignored", max_tokens: 10, messages: [{ role: "user", content: "hi" }] })
      .catch((e) => e);
    assert.equal(err.name, "ProviderHttpError");
    assert.equal(err.raw.includes(key), false);
    assert.equal(err.message.includes(key), false);
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

  test("sends anthropic-workspace-id when a workspace id is saved", async () => {
    delete process.env.LLM_PROVIDER;
    writeLlmConfig({
      provider: "cloud",
      cloud: { providerId: "anthropic", keySource: { type: "inline", key: "sk-ant-abcXYZ1234567890" }, anthropicWorkspaceId: "wrkspc_abc123" },
    });
    let sentHeader: string | undefined;
    const { withHostedFetch } = await import("../client");
    await withHostedFetch((async (_url: any, init: any) => {
      sentHeader = init?.headers?.["anthropic-workspace-id"];
      return new Response(JSON.stringify({ id: "x", content: [{ type: "text", text: "ok" }], usage: {} }), { status: 200 });
    }) as any, async () => {
      const client = makeLlmClient({ timeout: 5000 });
      await client.messages.create({ model: "claude-sonnet-4-6", max_tokens: 5, messages: [{ role: "user", content: "hi" }] });
    });
    assert.equal(sentHeader, "wrkspc_abc123");
  });

  test("no anthropic-workspace-id header when none is saved", async () => {
    delete process.env.LLM_PROVIDER;
    writeLlmConfig({ provider: "cloud", cloud: { providerId: "anthropic", keySource: { type: "inline", key: "sk-ant-abcXYZ1234567890" } } });
    let sentHeader: string | undefined = "unset";
    const { withHostedFetch } = await import("../client");
    await withHostedFetch((async (_url: any, init: any) => {
      sentHeader = init?.headers?.["anthropic-workspace-id"];
      return new Response(JSON.stringify({ id: "x", content: [{ type: "text", text: "ok" }], usage: {} }), { status: 200 });
    }) as any, async () => {
      const client = makeLlmClient({ timeout: 5000 });
      await client.messages.create({ model: "claude-sonnet-4-6", max_tokens: 5, messages: [{ role: "user", content: "hi" }] });
    });
    assert.equal(sentHeader, undefined);
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
