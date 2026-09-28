import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Runtime override for the LLM provider, written by the Settings UI (POST
 * /api/llm/config) and read by lib/llm/client.ts. Lets a user flip Local <->
 * Cloud from the running app, with no restart and no env var edit.
 *
 * Precedence: this file, when present and parseable, wins over LLM_PROVIDER /
 * ANTHROPIC_API_KEY entirely for the field(s) it sets. No file (or an
 * unreadable/corrupt one) means today's env-only behavior, unchanged.
 *
 * mtime-cached: re-read only when the file's mtime changes, so the hot path
 * (every LLM call) is a single stat(), not a read+parse.
 *
 * Gitignored (data/local) — this is a per-machine runtime setting, and it can
 * hold a plaintext Anthropic key.
 */

export type ProviderName = "ollama" | "anthropic";

export interface LlmConfigFile {
  provider?: ProviderName;
  anthropicApiKey?: string;
}

// Lazy (not a module-load-time constant) so tests can point this at an
// isolated temp file via GRANTED_LLM_CONFIG_PATH — the real app never sets it
// and always gets data/local/llm-config.json. This also keeps concurrent test
// FILES (each its own process, but sharing this disk) from racing on the same
// path when the whole suite runs together.
//
// Safety net: node:test sets NODE_TEST_CONTEXT on every test run (the `npm
// test` script and a single `tsx --test <file>` alike). If a test process
// gets here without GRANTED_LLM_CONFIG_PATH set, treat the config file as
// absent rather than fall through to the real data/local/llm-config.json —
// otherwise a checkout where Settings saved a Cloud config leaks a real
// Anthropic key into tests that only stub fetch, not the SDK.
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

/** Resolved Anthropic key: the saved key wins when set, else ANTHROPIC_API_KEY. */
export function resolveAnthropicKey(): string | undefined {
  const saved = readLlmConfig().anthropicApiKey;
  return saved || process.env.ANTHROPIC_API_KEY;
}

/** Test-only: drop the in-memory cache so the next read re-stats the file. */
export function resetLlmConfigCache(): void {
  cache = null;
}
