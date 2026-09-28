import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Runtime provider override written by Settings (POST /api/llm/config), read by lib/llm/client.ts.
// Wins over LLM_PROVIDER/ANTHROPIC_API_KEY when set. mtime-cached. Gitignored (data/local) — can hold a plaintext key.

export type ProviderName = "ollama" | "anthropic";
export type AnthropicKeySource = "saved" | "env";

// Real keys are "sk-ant-" + a long token; catches paste mistakes and the .env.example placeholder ("sk-ant-...").
const KEY_PATTERN = /^sk-ant-[A-Za-z0-9_-]+$/;
const MIN_KEY_LENGTH = 20;
const MAX_KEY_LENGTH = 200;

export function isValidAnthropicKey(key: string): boolean {
  return key.length >= MIN_KEY_LENGTH && key.length <= MAX_KEY_LENGTH && KEY_PATTERN.test(key);
}

export interface LlmConfigFile {
  provider?: ProviderName;
  anthropicApiKey?: string;
}

// Lazy so tests can isolate via GRANTED_LLM_CONFIG_PATH; under node:test with no override, treat the file as absent (never leak a real saved key into tests).
function configPath(): string {
  if (process.env.GRANTED_LLM_CONFIG_PATH) return process.env.GRANTED_LLM_CONFIG_PATH;
  if (process.env.NODE_TEST_CONTEXT) return path.join(os.tmpdir(), `granted-llm-config-unset-${process.pid}.json`);
  return path.join(process.cwd(), "data", "local", "llm-config.json");
}

let cache: { mtimeMs: number; config: LlmConfigFile; path: string } | null = null;

function parseConfig(text: string): LlmConfigFile {
  const parsed = JSON.parse(text);
  const config: LlmConfigFile = {};
  if (parsed?.provider === "ollama" || parsed?.provider === "anthropic") config.provider = parsed.provider;
  if (typeof parsed?.anthropicApiKey === "string" && parsed.anthropicApiKey.length > 0) {
    config.anthropicApiKey = parsed.anthropicApiKey;
  }
  return config;
}

/** Absent/corrupt file -> {} (today's env behavior). Never throws. */
export function readLlmConfig(): LlmConfigFile {
  const p = configPath();
  let stat: fs.Stats;
  try {
    stat = fs.statSync(p);
  } catch {
    cache = null;
    return {};
  }
  if (cache && cache.path === p && cache.mtimeMs === stat.mtimeMs) return cache.config;
  try {
    const config = parseConfig(fs.readFileSync(p, "utf8"));
    cache = { mtimeMs: stat.mtimeMs, config, path: p };
    return config;
  } catch {
    // Corrupt file: don't cache a bad read under a mtime that won't change
    // again on its own — fall back to env behavior for this call only.
    return {};
  }
}

/** Merges `patch` onto the current file and writes it atomically (temp + rename). */
export function writeLlmConfig(patch: LlmConfigFile): LlmConfigFile {
  const current = readLlmConfig();
  const next: LlmConfigFile = { ...current, ...patch };
  if (!next.anthropicApiKey) delete next.anthropicApiKey;
  if (!next.provider) delete next.provider;

  const p = configPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmpPath = `${p}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmpPath, p);
  cache = null; // next readLlmConfig() re-stats rather than trusting a stale mtime
  return next;
}

/** Resolved provider: config file wins when set, else LLM_PROVIDER, else "anthropic". */
export function resolveProvider(): string {
  const fromFile = readLlmConfig().provider;
  if (fromFile) return fromFile;
  return (process.env.LLM_PROVIDER || "anthropic").toLowerCase();
}

/** Resolved Anthropic key: the saved key wins when set, else a valid ANTHROPIC_API_KEY (placeholders ignored). */
export function resolveAnthropicKey(): string | undefined {
  const saved = readLlmConfig().anthropicApiKey;
  if (saved) return saved;
  const envKey = process.env.ANTHROPIC_API_KEY;
  return envKey && isValidAnthropicKey(envKey) ? envKey : undefined;
}

/** Where the resolved key (if any) came from — lets the UI say "from .env.local". */
export function resolveAnthropicKeySource(): AnthropicKeySource | undefined {
  if (readLlmConfig().anthropicApiKey) return "saved";
  const envKey = process.env.ANTHROPIC_API_KEY;
  return envKey && isValidAnthropicKey(envKey) ? "env" : undefined;
}

/** Test-only: drop the in-memory cache so the next read re-stats the file. */
export function resetLlmConfigCache(): void {
  cache = null;
}
