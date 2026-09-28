import { isCloudProviderId, getCloudProvider, isValidHttpsUrl, isSameCloudTarget, type CloudProviderId } from "./providers";
import { resolveKeySource, ENV_NAME_PATTERN, type KeySource } from "./keySource";
import { normalizeOpenAiBaseUrl } from "./baseUrl";
import { type CloudConfig } from "./config";

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

/**
 * Parses a key-source payload. `saved` is the currently persisted key source
 * for the same provider (undefined if none, or the provider changed) — a
 * payload of `{type:"saved"}`, or an omitted `keySource` entirely, falls back
 * to it. Lets Save/Test key/Load models reuse an already-saved pasted key
 * without the client ever resending or reprefilling the secret itself.
 */
export function parseKeySourceInput(raw: unknown, saved?: KeySource): KeySource | { error: string } {
  if (raw === undefined || raw === null) return saved ?? { error: NO_KEY_MESSAGE };
  if (typeof raw !== "object") return { error: NO_KEY_MESSAGE };
  const r = raw as Record<string, unknown>;
  if (r.type === "saved") return saved ?? { error: NO_KEY_MESSAGE };
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

/** The key source a blank/`saved` draft may reuse — only the saved config's, and only for the same target. */
export function savedKeySourceFor(saved: CloudConfig | undefined, providerId: CloudProviderId, baseUrl?: string): KeySource | undefined {
  return saved && isSameCloudTarget(saved, providerId, baseUrl) ? saved.keySource : undefined;
}

export function formatErrorMessage(providerId: CloudProviderId): string {
  if (providerId === "anthropic") return "That doesn't look like a valid Anthropic API key (it should start with sk-ant-).";
  if (providerId === "openai") return "That doesn't look like a valid OpenAI API key (it should start with sk-).";
  return "That doesn't look like a valid API key.";
}

/** Resolves + format-checks a key source for one provider, e.g. for "Test key" on a not-yet-saved draft. */
export function resolveDraftKey(providerId: CloudProviderId, keySourceInput: unknown, saved?: KeySource): { key?: string; error?: string } {
  const preset = getCloudProvider(providerId)!;
  const parsed = parseKeySourceInput(keySourceInput, saved);
  if ("error" in parsed) return { error: parsed.error };
  const resolved = resolveKeySource(parsed, preset.isKeyValid);
  if (resolved.error) return { error: resolved.error };
  if (!preset.isKeyValid(resolved.key!)) return { error: formatErrorMessage(providerId) };
  return { key: resolved.key };
}

/**
 * `currentCloud` is the presently saved cloud config, if any — its key source
 * is the "saved" fallback, but only for the same provider and base URL (a
 * saved key is never sent to a different endpoint).
 */
export function validateCloudConfig(input: CloudConfigInput, currentCloud?: CloudConfig): ValidationResult {
  if (!isCloudProviderId(input.providerId)) return { error: "Choose a cloud provider." };
  const providerId = input.providerId;
  const preset = getCloudProvider(providerId)!;

  let baseUrl: string | undefined;
  if (providerId === "other") {
    if (typeof input.baseUrl !== "string" || !input.baseUrl.trim()) return { error: "Enter a base URL for this provider." };
    baseUrl = input.baseUrl.trim();
    if (!isValidHttpsUrl(baseUrl)) return { error: "Enter a valid https base URL." };
    baseUrl = normalizeOpenAiBaseUrl(baseUrl);
  }

  const model = typeof input.model === "string" && input.model.trim() ? input.model.trim() : undefined;
  if (!model && !preset.defaultModel && providerId !== "anthropic") {
    return { error: "Choose a model for this provider." };
  }

  const parsed = parseKeySourceInput(input.keySource, savedKeySourceFor(currentCloud, providerId, baseUrl));
  if ("error" in parsed) return { error: parsed.error };

  const draft = resolveDraftKey(providerId, parsed);
  if (draft.error) return { error: draft.error };

  const config: CloudConfig = { providerId, keySource: parsed };
  if (baseUrl) config.baseUrl = baseUrl;
  if (model) config.model = model;
  return { config };
}
