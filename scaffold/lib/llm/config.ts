import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type CloudProviderId, isCloudProviderId, getCloudProvider } from "./providers";
import { type KeySource, resolveKeySource, type ResolvedKey } from "./keySource";
import { normalizeOpenAiBaseUrl } from "./baseUrl";

// Runtime provider override written by Settings (POST /api/llm/config), read by lib/llm/client.ts.
// Wins over LLM_PROVIDER/ANTHROPIC_API_KEY when set. mtime-cached. Gitignored (data/local) — can hold a plaintext key.

export type ProviderName = "ollama" | "cloud";
export type { CloudProviderId, KeySource };
export type CloudKeySource = KeySource;
export type AnthropicKeySource = "saved" | "env";

export interface CloudConfig {
  providerId: CloudProviderId;
  /** Only meaningful (and only persisted) for providerId "other". */
  baseUrl?: string;
  model?: string;
  keySource: CloudKeySource;
  /** Anthropic only: for a key that isn't scoped to a workspace (org-level key with multiple workspaces). Not secret. */
  anthropicWorkspaceId?: string;
}

// Anthropic workspace ids look like "wrkspc_" + an alphanumeric token.
export const ANTHROPIC_WORKSPACE_ID_PATTERN = /^wrkspc_[A-Za-z0-9]+$/;

export function isValidAnthropicWorkspaceId(id: string): boolean {
  return ANTHROPIC_WORKSPACE_ID_PATTERN.test(id);
}

// Real Anthropic keys are "sk-ant-" + a long token; catches paste mistakes and the .env.example placeholder ("sk-ant-...").
const KEY_PATTERN = /^sk-ant-[A-Za-z0-9_-]+$/;
const MIN_KEY_LENGTH = 20;
const MAX_KEY_LENGTH = 200;

/** Kept for #210 back-compat call sites; identical to the anthropic preset's format check. */
export function isValidAnthropicKey(key: string): boolean {
  return key.length >= MIN_KEY_LENGTH && key.length <= MAX_KEY_LENGTH && KEY_PATTERN.test(key);
}

export interface LlmConfigFile {
  // "anthropic" is accepted on read only (the #210 shape); the file is never written with it again.
  provider?: ProviderName | "anthropic";
  cloud?: CloudConfig;
  /** Legacy #210 shape: a bare saved Anthropic key. Still read and written for back-compat. */
  anthropicApiKey?: string;
}

// Lazy so tests can isolate via GRANTED_LLM_CONFIG_PATH; under node:test with no override, treat the file as absent (never leak a real saved key into tests).
function configPath(): string {
  if (process.env.GRANTED_LLM_CONFIG_PATH) return process.env.GRANTED_LLM_CONFIG_PATH;
  if (process.env.NODE_TEST_CONTEXT) return path.join(os.tmpdir(), `granted-llm-config-unset-${process.pid}.json`);
  return path.join(process.cwd(), "data", "local", "llm-config.json");
}

let cache: { mtimeMs: number; config: LlmConfigFile; path: string } | null = null;

function parseKeySource(raw: unknown): CloudKeySource | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  if (r.type === "inline" && typeof r.key === "string" && r.key.length > 0) return { type: "inline", key: r.key };
  if (r.type === "env" && typeof r.name === "string" && r.name.length > 0) return { type: "env", name: r.name };
  if (r.type === "file" && typeof r.path === "string" && r.path.length > 0) return { type: "file", path: r.path };
  return undefined;
}

function parseCloud(raw: unknown): CloudConfig | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  if (!isCloudProviderId(r.providerId)) return undefined;
  const keySource = parseKeySource(r.keySource);
  if (!keySource) return undefined;
  const cloud: CloudConfig = { providerId: r.providerId, keySource };
  if (typeof r.baseUrl === "string" && r.baseUrl.length > 0) cloud.baseUrl = r.baseUrl;
  if (typeof r.model === "string" && r.model.length > 0) cloud.model = r.model;
  if (
    r.providerId === "anthropic" &&
    typeof r.anthropicWorkspaceId === "string" &&
    isValidAnthropicWorkspaceId(r.anthropicWorkspaceId)
  ) {
    cloud.anthropicWorkspaceId = r.anthropicWorkspaceId;
  }
  return cloud;
}

function parseConfig(text: string): LlmConfigFile {
  const parsed = JSON.parse(text);
  const config: LlmConfigFile = {};
  if (parsed?.provider === "ollama") config.provider = "ollama";
  else if (parsed?.provider === "cloud" || parsed?.provider === "anthropic") config.provider = "cloud";

  const cloud = parseCloud(parsed?.cloud);
  if (cloud) config.cloud = cloud;

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

/**
 * A legacy #210 saved key, in `cloud` shape. Undefined once the file has a
 * proper `cloud` (which always wins) or no legacy key at all.
 */
function legacyAnthropicCloud(file: LlmConfigFile): CloudConfig | undefined {
  if (file.cloud || !file.anthropicApiKey) return undefined;
  return { providerId: "anthropic", keySource: { type: "inline", key: file.anthropicApiKey } };
}

/**
 * Carries a legacy #210 `anthropicApiKey` forward as `cloud` before a write
 * drops it, unless the patch itself explicitly sets (or clears) `cloud` —
 * that's an intentional replacement (a fresh cloud save) or purge
 * (clearCloud), and must not be overridden.
 */
function migrateLegacyAnthropicKey(current: LlmConfigFile, patch: LlmConfigFile): LlmConfigFile {
  if ("cloud" in patch) return current;
  const migrated = legacyAnthropicCloud(current);
  if (!migrated) return current;
  const { anthropicApiKey: _legacy, ...rest } = current;
  return { ...rest, cloud: migrated };
}

/** Merges `patch` onto the current file and writes it atomically (temp + rename). */
export function writeLlmConfig(patch: LlmConfigFile): LlmConfigFile {
  const current = migrateLegacyAnthropicKey(readLlmConfig(), patch);
  const next: LlmConfigFile = { ...current, ...patch };
  if (!next.anthropicApiKey) delete next.anthropicApiKey;
  if (!next.cloud) delete next.cloud;
  if (!next.provider || next.provider === "anthropic") {
    if (next.provider === "anthropic") next.provider = "cloud";
    else delete next.provider;
  }

  const p = configPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmpPath = `${p}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmpPath, p);
  cache = null; // next readLlmConfig() re-stats rather than trusting a stale mtime
  return next;
}

/** Resolved provider: config file wins when set, else LLM_PROVIDER, else "cloud". */
export function resolveProvider(): ProviderName {
  const fromFile = readLlmConfig().provider;
  if (fromFile === "ollama" || fromFile === "cloud") return fromFile;
  const envProvider = (process.env.LLM_PROVIDER || "").toLowerCase();
  // #210 back-compat: unset or "anthropic" -> hosted; any other value (ollama/openai/local) -> the OpenAI-compat shim.
  if (envProvider === "" || envProvider === "anthropic") return "cloud";
  return "ollama";
}

/**
 * Resolved cloud config, normalized from whichever shape is on disk (or env):
 * the new `cloud` object wins; else the #210 `anthropicApiKey`; else a valid
 * `ANTHROPIC_API_KEY` env var. Returns undefined when nothing resolves.
 */
export function resolveCloudConfig(file: LlmConfigFile = readLlmConfig()): CloudConfig | undefined {
  const fileCloud = file.cloud ?? legacyAnthropicCloud(file);
  if (fileCloud) return fileCloud;
  const envKey = process.env.ANTHROPIC_API_KEY;
  if (envKey && isValidAnthropicKey(envKey)) {
    return { providerId: "anthropic", keySource: { type: "env", name: "ANTHROPIC_API_KEY" } };
  }
  return undefined;
}

/** Resolves the actual secret for a cloud config (or the current one, if omitted). Never throws. */
export function resolveCloudApiKey(config?: CloudConfig): ResolvedKey {
  const cfg = config ?? resolveCloudConfig();
  if (!cfg) return { error: "No cloud provider is configured." };
  const preset = getCloudProvider(cfg.providerId);
  return resolveKeySource(cfg.keySource, preset?.isKeyValid);
}

/** The effective base URL for a cloud config's OpenAI-compatible shim call. Anthropic returns undefined (SDK path). */
export function resolveCloudBaseUrl(cfg: CloudConfig): string | undefined {
  const preset = getCloudProvider(cfg.providerId);
  if (!preset || preset.id === "anthropic") return undefined;
  const baseUrl = preset.baseUrl ?? cfg.baseUrl;
  return baseUrl ? normalizeOpenAiBaseUrl(baseUrl) : undefined;
}

/** The effective model: the user's saved choice, else the provider's suggested default. */
export function resolveCloudModel(cfg: CloudConfig): string | undefined {
  if (cfg.model) return cfg.model;
  return getCloudProvider(cfg.providerId)?.defaultModel;
}

/** Resolved Anthropic key — #210 back-compat: the saved key wins when set, else a valid ANTHROPIC_API_KEY (placeholders ignored). */
export function resolveAnthropicKey(): string | undefined {
  const cfg = resolveCloudConfig();
  if (!cfg || cfg.providerId !== "anthropic") return undefined;
  const resolved = resolveCloudApiKey(cfg);
  return resolved.key;
}

/** Where the resolved Anthropic key (if any) came from — lets the UI say "from .env.local". #210 back-compat. */
export function resolveAnthropicKeySource(): AnthropicKeySource | undefined {
  const cfg = resolveCloudConfig();
  if (!cfg || cfg.providerId !== "anthropic") return undefined;
  if (!resolveCloudApiKey(cfg).key) return undefined;
  return cfg.keySource.type === "env" ? "env" : "saved";
}

/** Test-only: drop the in-memory cache so the next read re-stats the file. */
export function resetLlmConfigCache(): void {
  cache = null;
}

/** A key source, stripped of the secret itself — safe to return from an API response. */
export function publicKeySource(ks: CloudKeySource): { type: "inline" } | { type: "env"; name: string } | { type: "file"; path: string } {
  if (ks.type === "env") return { type: "env", name: ks.name };
  if (ks.type === "file") return { type: "file", path: ks.path };
  return { type: "inline" };
}
