import { test, describe, before, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Isolated per-process path so this suite's writes never race the real
// data/local/llm-config.json that other suites in the full run assume is
// absent (see GRANTED_LLM_CONFIG_PATH in ../config). Set BEFORE the module is
// imported (in `before`, below) so it takes effect at first read.
const CONFIG_PATH = path.join(os.tmpdir(), `granted-llm-config-test-${process.pid}.json`);

let readLlmConfig: typeof import("../config").readLlmConfig;
let writeLlmConfig: typeof import("../config").writeLlmConfig;
let resolveProvider: typeof import("../config").resolveProvider;
let resolveCloudConfig: typeof import("../config").resolveCloudConfig;
let resolveCloudApiKey: typeof import("../config").resolveCloudApiKey;
let resolveAnthropicKey: typeof import("../config").resolveAnthropicKey;
let resolveAnthropicKeySource: typeof import("../config").resolveAnthropicKeySource;
let isValidAnthropicKey: typeof import("../config").isValidAnthropicKey;
let resetLlmConfigCache: typeof import("../config").resetLlmConfigCache;
let isLocalLlm: typeof import("../client").isLocalLlm;

before(async () => {
  process.env.GRANTED_LLM_CONFIG_PATH = CONFIG_PATH;
  const config = await import("../config");
  const client = await import("../client");
  ({
    readLlmConfig,
    writeLlmConfig,
    resolveProvider,
    resolveCloudConfig,
    resolveCloudApiKey,
    resolveAnthropicKey,
    resolveAnthropicKeySource,
    isValidAnthropicKey,
    resetLlmConfigCache,
  } = config);
  ({ isLocalLlm } = client);
});

const savedProvider = process.env.LLM_PROVIDER;
const savedKey = process.env.ANTHROPIC_API_KEY;

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
  if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = savedKey;
  removeConfigFile();
});

describe("llm/config — precedence", () => {
  test("absent file -> env behavior unchanged", () => {
    removeConfigFile();
    process.env.LLM_PROVIDER = "ollama";
    assert.equal(resolveProvider(), "ollama");
    delete process.env.LLM_PROVIDER;
    assert.equal(resolveProvider(), "cloud");
  });

  test("file's provider wins over LLM_PROVIDER", () => {
    process.env.LLM_PROVIDER = "ollama";
    writeLlmConfig({ provider: "cloud" });
    assert.equal(resolveProvider(), "cloud");
  });

  test("file's key wins over ANTHROPIC_API_KEY", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-envkeyvalue0000";
    writeLlmConfig({ provider: "cloud", anthropicApiKey: "sk-ant-savedkeyvalue0000" });
    assert.equal(resolveAnthropicKey(), "sk-ant-savedkeyvalue0000");
  });

  test("no saved key -> falls back to ANTHROPIC_API_KEY", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-envkeyvalue0000";
    writeLlmConfig({ provider: "cloud" });
    assert.equal(resolveAnthropicKey(), "sk-ant-envkeyvalue0000");
  });

  test("corrupt file -> falls back to env (never throws)", () => {
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    fs.writeFileSync(CONFIG_PATH, "{not json", "utf8");
    resetLlmConfigCache();
    process.env.LLM_PROVIDER = "ollama";
    assert.equal(resolveProvider(), "ollama");
  });

  test("write is atomic: no leftover .tmp file, and content round-trips", () => {
    writeLlmConfig({ provider: "ollama" });
    const base = path.basename(CONFIG_PATH);
    const leftovers = fs.readdirSync(path.dirname(CONFIG_PATH)).filter((f) => f.startsWith(`${base}.`) && f.endsWith(".tmp"));
    assert.deepEqual(leftovers, []);
    assert.deepEqual(readLlmConfig(), { provider: "ollama" });
  });

  test("switching provider affects isLocalLlm() immediately, no restart (mtime change)", () => {
    writeLlmConfig({ provider: "cloud" });
    assert.equal(isLocalLlm(), false);

    // Force a distinguishable mtime even on filesystems with coarse mtime
    // resolution, so the cache is guaranteed to see a change.
    writeLlmConfig({ provider: "ollama" });
    const stat = fs.statSync(CONFIG_PATH);
    fs.utimesSync(CONFIG_PATH, stat.atime, new Date(stat.mtimeMs + 5000));

    assert.equal(isLocalLlm(), true);
  });

  test("mtime-cached: repeated reads of an unchanged file agree", () => {
    writeLlmConfig({ provider: "ollama", anthropicApiKey: "sk-ant-cachedvalue0000" });
    const first = readLlmConfig();
    const second = readLlmConfig();
    assert.deepEqual(first, second);
  });

  test("a placeholder/malformed env key is ignored", () => {
    removeConfigFile();
    process.env.ANTHROPIC_API_KEY = "sk-ant-...";
    assert.equal(resolveAnthropicKey(), undefined);
    assert.equal(resolveAnthropicKeySource(), undefined);
  });

  test("resolveAnthropicKeySource: saved wins, then valid env, else undefined", () => {
    removeConfigFile();
    delete process.env.ANTHROPIC_API_KEY;
    assert.equal(resolveAnthropicKeySource(), undefined);

    process.env.ANTHROPIC_API_KEY = "sk-ant-envkeyvalue0000";
    assert.equal(resolveAnthropicKeySource(), "env");

    writeLlmConfig({ provider: "cloud", anthropicApiKey: "sk-ant-savedkeyvalue0000" });
    assert.equal(resolveAnthropicKeySource(), "saved");
  });

  test("isValidAnthropicKey: prefix, length bounds", () => {
    assert.equal(isValidAnthropicKey("sk-ant-..."), false);
    assert.equal(isValidAnthropicKey("not-a-key"), false);
    assert.equal(isValidAnthropicKey("sk-ant-x"), false);
    assert.equal(isValidAnthropicKey("sk-ant-" + "a".repeat(200)), false);
    assert.equal(isValidAnthropicKey("sk-ant-abcXYZ1234567890"), true);
  });
});

describe("llm/config — #210 back-compat", () => {
  test("legacy {provider:'anthropic', anthropicApiKey} file resolves as cloud/anthropic", () => {
    removeConfigFile();
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({ provider: "anthropic", anthropicApiKey: "sk-ant-legacykey00000" }), "utf8");
    resetLlmConfigCache();
    assert.equal(resolveProvider(), "cloud");
    assert.equal(isLocalLlm(), false);
    const cfg = resolveCloudConfig();
    assert.equal(cfg?.providerId, "anthropic");
    assert.deepEqual(cfg?.keySource, { type: "inline", key: "sk-ant-legacykey00000" });
  });

  test("LLM_PROVIDER=anthropic env (no file) resolves as cloud", () => {
    removeConfigFile();
    process.env.LLM_PROVIDER = "anthropic";
    assert.equal(resolveProvider(), "cloud");
  });

  test("LLM_PROVIDER=openai / local (legacy self-host values) still resolve as the local shim", () => {
    removeConfigFile();
    process.env.LLM_PROVIDER = "openai";
    assert.equal(resolveProvider(), "ollama");
    process.env.LLM_PROVIDER = "local";
    assert.equal(resolveProvider(), "ollama");
  });

  test("switching to ollama migrates a legacy anthropicApiKey into cloud instead of dropping it", () => {
    removeConfigFile();
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({ provider: "anthropic", anthropicApiKey: "sk-ant-legacykey00000" }), "utf8");
    resetLlmConfigCache();
    writeLlmConfig({ provider: "ollama", anthropicApiKey: undefined });
    const file = readLlmConfig();
    assert.equal(file.anthropicApiKey, undefined);
    assert.deepEqual(file.cloud, { providerId: "anthropic", keySource: { type: "inline", key: "sk-ant-legacykey00000" } });
    // Switching back to cloud with no key resolves the migrated key, not undefined.
    assert.deepEqual(resolveCloudConfig(), { providerId: "anthropic", keySource: { type: "inline", key: "sk-ant-legacykey00000" } });
  });

  test("any write that doesn't touch cloud migrates the legacy key and drops the legacy field", () => {
    removeConfigFile();
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({ provider: "ollama", anthropicApiKey: "sk-ant-legacykey00000" }), "utf8");
    resetLlmConfigCache();
    writeLlmConfig({ provider: "ollama" });
    assert.deepEqual(JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")), {
      provider: "ollama",
      cloud: { providerId: "anthropic", keySource: { type: "inline", key: "sk-ant-legacykey00000" } },
    });
  });

  test("clearCloud still purges a legacy anthropicApiKey entirely (no migration)", () => {
    removeConfigFile();
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({ provider: "anthropic", anthropicApiKey: "sk-ant-legacykey00000" }), "utf8");
    resetLlmConfigCache();
    writeLlmConfig({ provider: "ollama", anthropicApiKey: undefined, cloud: undefined });
    const file = readLlmConfig();
    assert.equal(file.anthropicApiKey, undefined);
    assert.equal(file.cloud, undefined);
  });

  test("new cloud object takes precedence over a legacy anthropicApiKey in the same file", () => {
    removeConfigFile();
    writeLlmConfig({ anthropicApiKey: "sk-ant-legacykey00000" });
    writeLlmConfig({
      provider: "cloud",
      cloud: { providerId: "openai", model: "gpt-4o-mini", keySource: { type: "inline", key: "sk-newerkey000000000" } },
    });
    const cfg = resolveCloudConfig();
    assert.equal(cfg?.providerId, "openai");
  });
});

describe("llm/config — cloud key sources", () => {
  test("env key source resolves process.env at use time", () => {
    removeConfigFile();
    process.env.MY_TEST_PROVIDER_KEY = "sk-test-envsourced0000";
    writeLlmConfig({ provider: "cloud", cloud: { providerId: "openrouter", keySource: { type: "env", name: "MY_TEST_PROVIDER_KEY" } } });
    const resolved = resolveCloudApiKey();
    assert.equal(resolved.key, "sk-test-envsourced0000");
    delete process.env.MY_TEST_PROVIDER_KEY;
  });

  test("env key source: unset variable -> error, no throw", () => {
    removeConfigFile();
    delete process.env.MY_UNSET_TEST_KEY;
    writeLlmConfig({ provider: "cloud", cloud: { providerId: "openrouter", keySource: { type: "env", name: "MY_UNSET_TEST_KEY" } } });
    const resolved = resolveCloudApiKey();
    assert.equal(resolved.key, undefined);
    assert.match(resolved.error ?? "", /MY_UNSET_TEST_KEY.*isn't set/);
  });
});
