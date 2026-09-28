import { isCloudProviderId, getCloudProvider, isValidHttpsUrl, type CloudProviderId } from "./providers";
import { resolveKeySource, ENV_NAME_PATTERN, type KeySource } from "./keySource";
import type { CloudConfig } from "./config";

// Shared validation for POST /api/llm/config's `cloud` payload: provider,
// base URL (only for "other"), and a key that both resolves and passes the
// provider's format check. Used at save time so Cloud can only be committed
// with a working key (see ModelSection.tsx / handler.ts).

export interface CloudConfigInput {
  providerId?: unknown;
  baseUrl?: unknown;
  model?: unknown;
  keySource?: unknown;
}

export interface ValidationResult {
  config?: CloudConfig;
  error?: string;
}

const NO_KEY_MESSAGE = "Please enter a key for your cloud provider.";

export function parseKeySourceInput(raw: unknown): KeySource | { error: string } {
  if (!raw || typeof raw !== "object") return { error: NO_KEY_MESSAGE };
  const r = raw as Record<string, unknown>;
  if (r.type === "inline") {
    if (typeof r.key !== "string" || !r.key.trim()) return { error: NO_KEY_MESSAGE };
    return { type: "inline", key: r.key.trim() };
  }
  if (r.type === "env") {
    if (typeof r.name !== "string" || !r.name.trim()) return { error: NO_KEY_MESSAGE };
    const name = r.name.trim();
    if (!ENV_NAME_PATTERN.test(name)) return { error: `"${name}" isn't a valid environment variable name.` };
    return { type: "env", name };
  }
  if (r.type === "file") {
    if (typeof r.path !== "string" || !r.path.trim()) return { error: NO_KEY_MESSAGE };
    return { type: "file", path: r.path.trim() };
  }
  return { error: NO_KEY_MESSAGE };
}

export function formatErrorMessage(providerId: CloudProviderId): string {
  if (providerId === "anthropic") return "That doesn't look like a valid Anthropic API key (it should start with sk-ant-).";
  if (providerId === "openai") return "That doesn't look like a valid OpenAI API key (it should start with sk-).";
  return "That doesn't look like a valid API key.";
}

/** Resolves + format-checks a key source for one provider, e.g. for "Test key" on a not-yet-saved draft. */
export function resolveDraftKey(providerId: CloudProviderId, keySourceInput: unknown): { key?: string; error?: string } {
  const preset = getCloudProvider(providerId)!;
  const parsed = parseKeySourceInput(keySourceInput);
  if ("error" in parsed) return { error: parsed.error };
  const resolved = resolveKeySource(parsed, preset.isKeyValid);
  if (resolved.error) return { error: resolved.error };
  if (!preset.isKeyValid(resolved.key!)) return { error: formatErrorMessage(providerId) };
  return { key: resolved.key };
}

export function validateCloudConfig(input: CloudConfigInput): ValidationResult {
  if (!isCloudProviderId(input.providerId)) return { error: "Choose a cloud provider." };
  const providerId = input.providerId;

  let baseUrl: string | undefined;
  if (providerId === "other") {
    if (typeof input.baseUrl !== "string" || !input.baseUrl.trim()) return { error: "Enter a base URL for this provider." };
    baseUrl = input.baseUrl.trim();
    if (!isValidHttpsUrl(baseUrl)) return { error: "Enter a valid https base URL." };
  }

  const model = typeof input.model === "string" && input.model.trim() ? input.model.trim() : undefined;

  const parsed = parseKeySourceInput(input.keySource);
  if ("error" in parsed) return { error: parsed.error };

  const draft = resolveDraftKey(providerId, parsed);
  if (draft.error) return { error: draft.error };

  const config: CloudConfig = { providerId, keySource: parsed };
  if (baseUrl) config.baseUrl = baseUrl;
  if (model) config.model = model;
  return { config };
}
