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
    const res = await handleLlmConfigPost(fakeReq({ provider: "openai" }), deps);
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

  test("400 switching to anthropic with no saved key and no env key", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const deps = fakeDeps();
    const res = await handleLlmConfigPost(fakeReq({ provider: "anthropic" }), deps);
    const json = await res.json();
    assert.equal(res.status, 400);
    assert.match(json.error, /key/i);
  });

  test("switching to anthropic succeeds when an env key exists, without persisting the env key", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-envkey0000000000";
    const deps = fakeDeps();
    const res = await handleLlmConfigPost(fakeReq({ provider: "anthropic" }), deps);
    assert.equal(res.status, 200);
    assert.equal(deps._get().anthropicApiKey, undefined);
    delete process.env.ANTHROPIC_API_KEY;
  });

  test("400 on a malformed key (bad prefix)", async () => {
    const deps = fakeDeps();
    const res = await handleLlmConfigPost(
      fakeReq({ provider: "anthropic", anthropicApiKey: "not-a-real-key-at-all" }),
      deps,
    );
    assert.equal(res.status, 400);
  });

  test("400 on a too-short key", async () => {
    const deps = fakeDeps();
    const res = await handleLlmConfigPost(fakeReq({ provider: "anthropic", anthropicApiKey: "sk-ant-x" }), deps);
    assert.equal(res.status, 400);
  });

  test("saves a valid key, trimmed, and switches to anthropic", async () => {
    const deps = fakeDeps();
    const res = await handleLlmConfigPost(
      fakeReq({ provider: "anthropic", anthropicApiKey: "  sk-ant-abcXYZ1234567890  " }),
      deps,
    );
    const json = await res.json();
    assert.equal(res.status, 200);
    assert.equal(deps._get().anthropicApiKey, "sk-ant-abcXYZ1234567890");
    assert.equal(json.hasAnthropicKey, true);
  });

  test("clearAnthropicKey removes a saved key", async () => {
    const deps = fakeDeps({}, { provider: "anthropic", anthropicApiKey: "sk-ant-existingkey0000" });
    process.env.ANTHROPIC_API_KEY = "sk-ant-envkey0000000000";
    const res = await handleLlmConfigPost(fakeReq({ provider: "anthropic", clearAnthropicKey: true }), deps);
    assert.equal(res.status, 200);
    assert.equal(deps._get().anthropicApiKey, undefined);
    delete process.env.ANTHROPIC_API_KEY;
  });

  test("never echoes the key back in the response", async () => {
    const deps = fakeDeps();
    const res = await handleLlmConfigPost(
      fakeReq({ provider: "anthropic", anthropicApiKey: "sk-ant-abcXYZ1234567890" }),
      deps,
    );
    const json = await res.json();
    assert.equal(JSON.stringify(json).includes("sk-ant-abcXYZ1234567890"), false);
  });
});
