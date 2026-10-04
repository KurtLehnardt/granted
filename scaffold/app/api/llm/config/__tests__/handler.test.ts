import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { handleLlmConfigPost, type LlmConfigDeps } from "../handler";
import { readLlmConfig, resolveCloudConfig, resetLlmConfigCache, type LlmConfigFile } from "@/lib/llm/config";
import type { LocalEmbeddingsStatus } from "@/lib/embeddings/localEmbeddings";

async function withRealConfigFile(initial: object, fn: () => Promise<void>) {
  const p = path.join(os.tmpdir(), `granted-llm-config-handler-${process.pid}-${Date.now()}.json`);
  const prev = process.env.GRANTED_LLM_CONFIG_PATH;
  process.env.GRANTED_LLM_CONFIG_PATH = p;
  fs.writeFileSync(p, JSON.stringify(initial), "utf8");
  resetLlmConfigCache();
  try {
    await fn();
  } finally {
    fs.rmSync(p, { force: true });
    if (prev === undefined) delete process.env.GRANTED_LLM_CONFIG_PATH;
    else process.env.GRANTED_LLM_CONFIG_PATH = prev;
    resetLlmConfigCache();
  }
}

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
    localEmbeddingsStatus: () => null,
    startLocalEmbeddings: () => {
      throw new Error("fakeDeps: no local-embeddings job in these tests");
    },
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
      fakeReq({ provider: "cloud", cloud: { providerId: "other", baseUrl: "https://my-proxy.example.com/v1", model: "custom-model", keySource: { type: "inline", key: "a-fine-key-value" } } }),
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

  test("400 saving a provider with no default model and none given (openrouter/mistral/other)", async () => {
    for (const providerId of ["openrouter", "mistral"]) {
      const deps = fakeDeps();
      const res = await handleLlmConfigPost(
        fakeReq({ provider: "cloud", cloud: { providerId, keySource: { type: "inline", key: "a-fine-key-value000" } } }),
        deps,
      );
      const json = await res.json();
      assert.equal(res.status, 400, providerId);
      assert.match(json.error, /model/i);
    }
  });

  test("saving openrouter with a model succeeds", async () => {
    const deps = fakeDeps();
    const res = await handleLlmConfigPost(
      fakeReq({ provider: "cloud", cloud: { providerId: "openrouter", model: "some/model", keySource: { type: "inline", key: "a-fine-key-value000" } } }),
      deps,
    );
    assert.equal(res.status, 200);
  });

  test("anthropic needs no model even with no default", async () => {
    const deps = fakeDeps();
    const res = await handleLlmConfigPost(
      fakeReq({ provider: "cloud", cloud: { providerId: "anthropic", keySource: { type: "inline", key: "sk-ant-abcXYZ1234567890" } } }),
      deps,
    );
    assert.equal(res.status, 200);
  });

  test("switching to ollama moves a legacy #210 key into cloud rather than dropping it (real file)", async () => {
    await withRealConfigFile({ provider: "anthropic", anthropicApiKey: "sk-ant-legacyplaintext0" }, async () => {
      const res = await handleLlmConfigPost(fakeReq({ provider: "ollama" }), { isLoopbackRequest: () => true, localEmbeddingsStatus: () => null });
      assert.equal(res.status, 200);
      assert.deepEqual(readLlmConfig(), {
        provider: "ollama",
        cloud: { providerId: "anthropic", keySource: { type: "inline", key: "sk-ant-legacyplaintext0" } },
      });
      assert.equal(resolveCloudConfig()?.keySource.type, "inline");
    });
  });

  test("clearCloud on a legacy #210 file removes the key entirely (real file)", async () => {
    await withRealConfigFile({ provider: "anthropic", anthropicApiKey: "sk-ant-legacyplaintext0" }, async () => {
      const res = await handleLlmConfigPost(fakeReq({ provider: "ollama", clearCloud: true }), { isLoopbackRequest: () => true, localEmbeddingsStatus: () => null });
      assert.equal(res.status, 200);
      assert.deepEqual(readLlmConfig(), { provider: "ollama" });
    });
  });

  test("Save with a blank draft works for the common #210 state {provider:'ollama', anthropicApiKey} (real file)", async () => {
    await withRealConfigFile({ provider: "ollama", anthropicApiKey: "sk-ant-legacyplaintext0" }, async () => {
      const res = await handleLlmConfigPost(
        fakeReq({ provider: "cloud", cloud: { providerId: "anthropic", keySource: { type: "saved" } } }),
        { isLoopbackRequest: () => true, localEmbeddingsStatus: () => null },
      );
      assert.equal(res.status, 200);
      assert.deepEqual(readLlmConfig(), {
        provider: "cloud",
        cloud: { providerId: "anthropic", keySource: { type: "inline", key: "sk-ant-legacyplaintext0" } },
      });
    });
  });

  test("a cloud save purges a legacy #210 plaintext key even when switching key source type", async () => {
    const deps = fakeDeps({}, { provider: "anthropic", anthropicApiKey: "sk-ant-legacyplaintext0" });
    process.env.GRANTED_CONFIG_TEST_ENV_SWITCH = "sk-ant-fromenvvalue0000";
    const res = await handleLlmConfigPost(
      fakeReq({ provider: "cloud", cloud: { providerId: "anthropic", keySource: { type: "env", name: "GRANTED_CONFIG_TEST_ENV_SWITCH" } } }),
      deps,
    );
    assert.equal(res.status, 200);
    assert.equal(deps._get().anthropicApiKey, undefined);
    delete process.env.GRANTED_CONFIG_TEST_ENV_SWITCH;
  });

  test("keySource {type:'saved'} reuses a legacy #210 anthropicApiKey (no cloud object yet)", async () => {
    const deps = fakeDeps({}, { provider: "ollama", anthropicApiKey: "sk-ant-legacykey00000" });
    const res = await handleLlmConfigPost(
      fakeReq({ provider: "cloud", cloud: { providerId: "anthropic", keySource: { type: "saved" } } }),
      deps,
    );
    assert.equal(res.status, 200);
    assert.deepEqual(deps._get().cloud?.keySource, { type: "inline", key: "sk-ant-legacykey00000" });
  });

  test("keySource {type:'saved'} reuses the previously saved key for the same provider", async () => {
    const deps = fakeDeps({}, { provider: "cloud", cloud: { providerId: "openai", model: "gpt-4o", keySource: { type: "inline", key: "sk-savedopenaikey0000" } } });
    const res = await handleLlmConfigPost(
      fakeReq({ provider: "cloud", cloud: { providerId: "openai", model: "gpt-4o-mini", keySource: { type: "saved" } } }),
      deps,
    );
    assert.equal(res.status, 200);
    assert.deepEqual(deps._get().cloud?.keySource, { type: "inline", key: "sk-savedopenaikey0000" });
    assert.equal(deps._get().cloud?.model, "gpt-4o-mini");
  });

  test("keySource {type:'saved'} falls back to a valid ANTHROPIC_API_KEY, saved as a reference (same as Test key)", async () => {
    const prev = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "sk-ant-fromenvironment00";
    try {
      const deps = fakeDeps();
      const res = await handleLlmConfigPost(
        fakeReq({ provider: "cloud", cloud: { providerId: "anthropic", keySource: { type: "saved" } } }),
        deps,
      );
      assert.equal(res.status, 200);
      assert.deepEqual(deps._get().cloud?.keySource, { type: "env", name: "ANTHROPIC_API_KEY" });
    } finally {
      if (prev === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = prev;
    }
  });

  test("'other': a saved key is never reused for a different base URL", async () => {
    const deps = fakeDeps({}, {
      provider: "cloud",
      cloud: { providerId: "other", baseUrl: "https://a.example.com/v1", model: "m", keySource: { type: "inline", key: "saved-other-key-0000" } },
    });
    const moved = await handleLlmConfigPost(
      fakeReq({ provider: "cloud", cloud: { providerId: "other", baseUrl: "https://b.example.com/v1", model: "m", keySource: { type: "saved" } } }),
      deps,
    );
    assert.equal(moved.status, 400);
    const same = await handleLlmConfigPost(
      fakeReq({ provider: "cloud", cloud: { providerId: "other", baseUrl: "https://a.example.com/v1/", model: "m2", keySource: { type: "saved" } } }),
      deps,
    );
    assert.equal(same.status, 200);
    assert.equal(deps._get().cloud?.baseUrl, "https://a.example.com/v1");
  });

  test("keySource {type:'saved'} after switching provider -> 400, the old key is not reused", async () => {
    const deps = fakeDeps({}, { provider: "cloud", cloud: { providerId: "openai", model: "gpt-4o", keySource: { type: "inline", key: "sk-savedopenaikey0000" } } });
    const res = await handleLlmConfigPost(
      fakeReq({ provider: "cloud", cloud: { providerId: "groq", model: "llama-3.3-70b-versatile", keySource: { type: "saved" } } }),
      deps,
    );
    const json = await res.json();
    assert.equal(res.status, 400);
    assert.equal(json.error, "Please enter a key for your cloud provider.");
  });
});

describe("POST /api/llm/config — switching to Local starts local search setup", () => {
  const status = (s: Partial<LocalEmbeddingsStatus>): LocalEmbeddingsStatus => ({ state: "needed", model: "nomic-embed-text", active: false, ...s });

  function withEmbeddings(initial: LocalEmbeddingsStatus | null, startImpl?: () => void) {
    let current = initial;
    let starts = 0;
    const deps = fakeDeps({
      localEmbeddingsStatus: () => current,
      startLocalEmbeddings: () => {
        starts++;
        if (startImpl) startImpl();
        current = status({ state: "running", progress: { stage: "checking" } });
      },
    });
    return { deps, starts: () => starts };
  }

  test("nothing built yet → starts the background job and returns its running status", async () => {
    const { deps, starts } = withEmbeddings(status({}));
    const res = await handleLlmConfigPost(fakeReq({ provider: "ollama" }), deps);
    assert.equal(res.status, 200);
    assert.equal(starts(), 1);
    const json = await res.json();
    assert.equal(json.provider, "ollama");
    assert.equal(json.localEmbeddings.state, "running");
  });

  test("a previous failure → re-picking Local retries", async () => {
    const { deps, starts } = withEmbeddings(status({ state: "failed", error: "x" }));
    await handleLlmConfigPost(fakeReq({ provider: "ollama" }), deps);
    assert.equal(starts(), 1);
  });

  test("index already ready → no job, search switches to it immediately", async () => {
    const { deps, starts } = withEmbeddings(status({ state: "ready", active: true, outdated: false }));
    const json = await (await handleLlmConfigPost(fakeReq({ provider: "ollama" }), deps)).json();
    assert.equal(starts(), 0);
    assert.equal(json.localEmbeddings.state, "ready");
  });

  test("ready but built from an older corpus → refreshes it in the background", async () => {
    const { deps, starts } = withEmbeddings(status({ state: "ready", active: true, outdated: true }));
    await handleLlmConfigPost(fakeReq({ provider: "ollama" }), deps);
    assert.equal(starts(), 1);
  });

  test("already running, or embeddings set in .env.local → no second job", async () => {
    for (const s of [status({ state: "running" }), status({ state: "not-applicable" })]) {
      const { deps, starts } = withEmbeddings(s);
      await handleLlmConfigPost(fakeReq({ provider: "ollama" }), deps);
      assert.equal(starts(), 0, s.state);
    }
  });

  test("the job failing to spawn never fails the provider switch", async () => {
    const { deps } = withEmbeddings(status({}), () => {
      throw new Error("EACCES");
    });
    const res = await handleLlmConfigPost(fakeReq({ provider: "ollama" }), deps);
    assert.equal(res.status, 200);
    assert.deepEqual(deps._get(), { provider: "ollama" });
  });

  test("a cloud save never starts it", async () => {
    const { deps, starts } = withEmbeddings(status({}));
    const res = await handleLlmConfigPost(
      fakeReq({ provider: "cloud", cloud: { providerId: "anthropic", keySource: { type: "inline", key: "sk-ant-abcXYZ1234567890" } } }),
      deps,
    );
    assert.equal(res.status, 200);
    assert.equal(starts(), 0);
  });
});
