import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { handleLlmConfigPost, type LlmConfigDeps } from "../handler";
import type { LlmConfigFile } from "@/lib/llm/config";

function fakeReq(body?: unknown): { headers: { get(name: string): string | null }; json: () => Promise<unknown> } {
  return {
    headers: { get: () => null },
    json: async () => {
      if (body === undefined) throw new Error("no body");
      return body;
    },
  };
}

function fakeDeps(overrides: Partial<LlmConfigDeps> = {}, initial: LlmConfigFile = {}) {
  let stored: LlmConfigFile = { ...initial };
  const writes: LlmConfigFile[] = [];
  return {
    isLoopbackRequest: () => true,
    readLlmConfig: () => stored,
    writeLlmConfig: (patch: LlmConfigFile) => {
      stored = { ...stored, ...patch };
      if (!stored.anthropicApiKey) delete stored.anthropicApiKey;
      if (!stored.cloud) delete stored.cloud;
      writes.push({ ...stored });
      return stored;
    },
    ...overrides,
    _writes: writes,
    _get: () => stored,
  } as LlmConfigDeps & { _writes: LlmConfigFile[]; _get: () => LlmConfigFile };
}

describe("POST /api/llm/config", () => {
  test("403 when not loopback", async () => {
    const deps = fakeDeps({ isLoopbackRequest: () => false });
    const res = await handleLlmConfigPost(fakeReq({ provider: "ollama" }), deps);
    assert.equal(res.status, 403);
  });

  test("400 on invalid provider", async () => {
    const deps = fakeDeps();
    const res = await handleLlmConfigPost(fakeReq({ provider: "anthropic" }), deps);
    assert.equal(res.status, 400);
  });

  test("400 on invalid request body", async () => {
    const deps = fakeDeps();
    const res = await handleLlmConfigPost(fakeReq(undefined), deps);
    assert.equal(res.status, 400);
  });

  test("switches to ollama with no key needed", async () => {
    const deps = fakeDeps();
    const res = await handleLlmConfigPost(fakeReq({ provider: "ollama" }), deps);
    assert.equal(res.status, 200);
    assert.deepEqual(deps._get(), { provider: "ollama" });
  });

  test("400 saving cloud with no key at all -> the inline message", async () => {
    const deps = fakeDeps();
    const res = await handleLlmConfigPost(fakeReq({ provider: "cloud", cloud: { providerId: "anthropic" } }), deps);
    const json = await res.json();
    assert.equal(res.status, 400);
    assert.equal(json.error, "Please enter a key for your cloud provider.");
  });

  test("400 on an unknown providerId", async () => {
    const deps = fakeDeps();
    const res = await handleLlmConfigPost(
      fakeReq({ provider: "cloud", cloud: { providerId: "not-a-real-provider", keySource: { type: "inline", key: "x" } } }),
      deps,
    );
    assert.equal(res.status, 400);
  });

  test("400 on a malformed anthropic key (bad prefix)", async () => {
    const deps = fakeDeps();
    const res = await handleLlmConfigPost(
      fakeReq({ provider: "cloud", cloud: { providerId: "anthropic", keySource: { type: "inline", key: "not-a-real-key-at-all" } } }),
      deps,
    );
    const json = await res.json();
    assert.equal(res.status, 400);
    assert.match(json.error, /doesn't look like a valid/);
  });

  test("400 on a too-short anthropic key", async () => {
    const deps = fakeDeps();
    const res = await handleLlmConfigPost(
      fakeReq({ provider: "cloud", cloud: { providerId: "anthropic", keySource: { type: "inline", key: "sk-ant-x" } } }),
      deps,
    );
    assert.equal(res.status, 400);
  });

  test("saves a valid anthropic key, trimmed, and switches to cloud", async () => {
    const deps = fakeDeps();
    const res = await handleLlmConfigPost(
      fakeReq({ provider: "cloud", cloud: { providerId: "anthropic", keySource: { type: "inline", key: "  sk-ant-abcXYZ1234567890  " } } }),
      deps,
    );
    const json = await res.json();
    assert.equal(res.status, 200);
    assert.equal(deps._get().cloud?.providerId, "anthropic");
    assert.deepEqual(deps._get().cloud?.keySource, { type: "inline", key: "sk-ant-abcXYZ1234567890" });
    assert.equal(json.cloud.providerId, "anthropic");
    assert.deepEqual(json.cloud.keySource, { type: "inline" });
  });

  test("saves a non-anthropic provider with its model", async () => {
    const deps = fakeDeps();
    const res = await handleLlmConfigPost(
      fakeReq({ provider: "cloud", cloud: { providerId: "openai", model: "gpt-4o", keySource: { type: "inline", key: "sk-openaikeyvalue0000" } } }),
      deps,
    );
    const json = await res.json();
    assert.equal(res.status, 200);
    assert.equal(json.cloud.providerId, "openai");
    assert.equal(json.cloud.model, "gpt-4o");
  });

  test("'other' provider requires a valid https base URL", async () => {
    const deps = fakeDeps();
    const missingUrl = await handleLlmConfigPost(
      fakeReq({ provider: "cloud", cloud: { providerId: "other", keySource: { type: "inline", key: "a-fine-key-value" } } }),
      deps,
    );
    assert.equal(missingUrl.status, 400);

    const badUrl = await handleLlmConfigPost(
      fakeReq({ provider: "cloud", cloud: { providerId: "other", baseUrl: "http://not-https.example.com", keySource: { type: "inline", key: "a-fine-key-value" } } }),
      deps,
    );
    assert.equal(badUrl.status, 400);

    const ok = await handleLlmConfigPost(
      fakeReq({ provider: "cloud", cloud: { providerId: "other", baseUrl: "https://my-proxy.example.com/v1", keySource: { type: "inline", key: "a-fine-key-value" } } }),
      deps,
    );
    assert.equal(ok.status, 200);
    const json = await ok.json();
    assert.equal(json.cloud.baseUrl, "https://my-proxy.example.com/v1");
  });

  test("env key source: unset variable -> 400 'isn't set'", async () => {
    delete process.env.GRANTED_CONFIG_TEST_UNSET;
    const deps = fakeDeps();
    const res = await handleLlmConfigPost(
      fakeReq({ provider: "cloud", cloud: { providerId: "openai", keySource: { type: "env", name: "GRANTED_CONFIG_TEST_UNSET" } } }),
      deps,
    );
    const json = await res.json();
    assert.equal(res.status, 400);
    assert.match(json.error, /GRANTED_CONFIG_TEST_UNSET.*isn't set/);
  });

  test("env key source: invalid variable name -> 400", async () => {
    const deps = fakeDeps();
    const res = await handleLlmConfigPost(
      fakeReq({ provider: "cloud", cloud: { providerId: "openai", keySource: { type: "env", name: "not valid!" } } }),
      deps,
    );
    assert.equal(res.status, 400);
  });

  test("env key source: set, valid -> saves the reference only, never the value", async () => {
    process.env.GRANTED_CONFIG_TEST_KEY = "sk-envprovidedkey0000";
    const deps = fakeDeps();
    const res = await handleLlmConfigPost(
      fakeReq({ provider: "cloud", cloud: { providerId: "openai", keySource: { type: "env", name: "GRANTED_CONFIG_TEST_KEY" } } }),
      deps,
    );
    const json = await res.json();
    assert.equal(res.status, 200);
    assert.deepEqual(deps._get().cloud?.keySource, { type: "env", name: "GRANTED_CONFIG_TEST_KEY" });
    assert.equal(JSON.stringify(json).includes("sk-envprovidedkey0000"), false);
    delete process.env.GRANTED_CONFIG_TEST_KEY;
  });

  test("file key source: missing file -> 400 \"Couldn't read\"", async () => {
    const deps = fakeDeps();
    const res = await handleLlmConfigPost(
      fakeReq({ provider: "cloud", cloud: { providerId: "openai", keySource: { type: "file", path: "/definitely/not/a/real/path.key" } } }),
      deps,
    );
    const json = await res.json();
    assert.equal(res.status, 400);
    assert.match(json.error, /Couldn't read/);
  });

  test("switching to ollama keeps the previously saved cloud config", async () => {
    const deps = fakeDeps({}, { provider: "cloud", cloud: { providerId: "anthropic", keySource: { type: "inline", key: "sk-ant-existingkey0000" } } });
    const res = await handleLlmConfigPost(fakeReq({ provider: "ollama" }), deps);
    assert.equal(res.status, 200);
    assert.equal(deps._get().cloud?.providerId, "anthropic");
    assert.equal(deps._get().provider, "ollama");
  });

  test("clearCloud removes the saved cloud config when switching to ollama", async () => {
    const deps = fakeDeps({}, { provider: "cloud", cloud: { providerId: "anthropic", keySource: { type: "inline", key: "sk-ant-existingkey0000" } } });
    const res = await handleLlmConfigPost(fakeReq({ provider: "ollama", clearCloud: true }), deps);
    assert.equal(res.status, 200);
    assert.equal(deps._get().cloud, undefined);
  });

  test("never echoes the key back in the response", async () => {
    const deps = fakeDeps();
    const res = await handleLlmConfigPost(
      fakeReq({ provider: "cloud", cloud: { providerId: "anthropic", keySource: { type: "inline", key: "sk-ant-abcXYZ1234567890" } } }),
      deps,
    );
    const json = await res.json();
    assert.equal(JSON.stringify(json).includes("sk-ant-abcXYZ1234567890"), false);
  });
});
