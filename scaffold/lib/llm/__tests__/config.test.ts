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
    assert.equal(resolveProvider(), "anthropic");
  });

  test("file's provider wins over LLM_PROVIDER", () => {
    process.env.LLM_PROVIDER = "ollama";
    writeLlmConfig({ provider: "anthropic" });
    assert.equal(resolveProvider(), "anthropic");
  });

  test("file's key wins over ANTHROPIC_API_KEY", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-envkeyvalue0000";
    writeLlmConfig({ provider: "anthropic", anthropicApiKey: "sk-ant-savedkeyvalue0000" });
    assert.equal(resolveAnthropicKey(), "sk-ant-savedkeyvalue0000");
  });

  test("no saved key -> falls back to ANTHROPIC_API_KEY", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-envkeyvalue0000";
    writeLlmConfig({ provider: "anthropic" });
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
    writeLlmConfig({ provider: "anthropic" });
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

    writeLlmConfig({ provider: "anthropic", anthropicApiKey: "sk-ant-savedkeyvalue0000" });
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
