import { normalizeOpenAiBaseUrl, normalizeAnthropicBaseUrl } from "./baseUrl";
import { isLoopbackIp } from "../corpus/loopback";

// Cloud provider registry. Anthropic (and any other preset with
// usesAnthropicSdk) runs through the real SDK (see client.ts); every other
// preset is an OpenAI-compatible endpoint reached through the existing
// OpenAI-compat shim, with the preset's base URL and a bearer key.

export type CloudProviderId =
  | "anthropic"
  | "openai"
  | "google"
  | "openrouter"
  | "groq"
  | "mistral"
  | "fcc"
  | "other";

/** A key source suggested by default when a preset is first selected — see keySource.ts. */
export type DefaultKeySource = { type: "file"; path: string };

export interface CloudProviderPreset {
  id: CloudProviderId;
  label: string;
  /** Fixed base URL for a preset provider. Undefined for "other"/"fcc", which take a user-entered URL. */
  baseUrl?: string;
  /** True when the base URL is user-entered rather than fixed ("other", "fcc"). */
  editableBaseUrl?: boolean;
  /** "fcc" only: http is accepted for a loopback host (localhost/127.0.0.1/[::1]); every other base URL requires https. */
  allowHttpLoopbackOnly?: boolean;
  defaultModel?: string;
  /** Authenticated GET used by "Test key"; defaults to /models. */
  keyProbePath?: string;
  /** True for a preset reached through the real Anthropic SDK (client.ts) rather than the OpenAI-compat shim. */
  usesAnthropicSdk?: boolean;
  /** How the SDK sends the credential when usesAnthropicSdk: "apiKey" (x-api-key, default) or "authToken" (Authorization: Bearer). */
  authMode?: "apiKey" | "authToken";
  /** Suggested key source the UI prefills when this preset is first selected. */
  defaultKeySource?: DefaultKeySource;
  /** Caps simultaneous in-flight calls for this preset (gentler free-tier concurrency). Undefined = unlimited. */
  concurrency?: number;
  /** One-line privacy note shown in Settings when this preset is selected. */
  privacyNote?: string;
  isKeyValid(key: string): boolean;
}

const MIN_GENERIC_KEY_LENGTH = 8;
const MAX_GENERIC_KEY_LENGTH = 400;
const MIN_STRICT_KEY_LENGTH = 20;
const MAX_STRICT_KEY_LENGTH = 200;

function hasNoWhitespace(key: string): boolean {
  return !/\s/.test(key);
}

/** Non-empty, no whitespace, sane length bounds — the floor for any cloud provider's key. */
export function genericKeyCheck(key: string): boolean {
  return (
    key.length >= MIN_GENERIC_KEY_LENGTH && key.length <= MAX_GENERIC_KEY_LENGTH && hasNoWhitespace(key)
  );
}

const ANTHROPIC_KEY_PATTERN = /^sk-ant-[A-Za-z0-9_-]+$/;
const OPENAI_KEY_PATTERN = /^sk-/;

function isValidAnthropicKeyFormat(key: string): boolean {
  return (
    key.length >= MIN_STRICT_KEY_LENGTH &&
    key.length <= MAX_STRICT_KEY_LENGTH &&
    hasNoWhitespace(key) &&
    ANTHROPIC_KEY_PATTERN.test(key)
  );
}

function isValidOpenAiKeyFormat(key: string): boolean {
  return (
    key.length >= MIN_STRICT_KEY_LENGTH &&
    key.length <= MAX_STRICT_KEY_LENGTH &&
    hasNoWhitespace(key) &&
    OPENAI_KEY_PATTERN.test(key)
  );
}

export const CLOUD_PROVIDERS: readonly CloudProviderPreset[] = [
  {
    id: "anthropic",
    label: "Anthropic (Claude)",
    usesAnthropicSdk: true,
    isKeyValid: isValidAnthropicKeyFormat,
  },
  {
    id: "openai",
    label: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    defaultModel: "gpt-4o-mini",
    isKeyValid: isValidOpenAiKeyFormat,
  },
  {
    id: "google",
    label: "Google Gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    defaultModel: "gemini-2.0-flash",
    isKeyValid: genericKeyCheck,
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    keyProbePath: "/key", // its /models is public, so it can't tell a bad key from a good one
    concurrency: 2, // gentle on free-tier (:free) rate limits
    isKeyValid: genericKeyCheck,
  },
  {
    id: "groq",
    label: "Groq",
    baseUrl: "https://api.groq.com/openai/v1",
    defaultModel: "llama-3.3-70b-versatile",
    concurrency: 2, // gentle on free-tier rate limits
    isKeyValid: genericKeyCheck,
  },
  {
    id: "mistral",
    label: "Mistral",
    baseUrl: "https://api.mistral.ai/v1",
    isKeyValid: genericKeyCheck,
  },
  {
    id: "fcc",
    label: "Anthropic-compatible proxy (e.g. Free Claude Code)",
    baseUrl: "http://127.0.0.1:8082",
    editableBaseUrl: true,
    allowHttpLoopbackOnly: true,
    usesAnthropicSdk: true,
    authMode: "authToken", // FCC validates "Authorization: Bearer <token>", never x-api-key
    defaultModel: "claude-sonnet-4-20250514", // an id FCC's catalog maps to a configured free-provider model
    defaultKeySource: { type: "file", path: "~/.fcc/proxy_auth_token" },
    concurrency: 2, // gentle on free-tier upstream rate limits
    privacyNote: "Prompts are forwarded to third-party free providers, which may log them.",
    isKeyValid: genericKeyCheck,
  },
  {
    id: "other",
    label: "Other (OpenAI-compatible)",
    editableBaseUrl: true,
    isKeyValid: genericKeyCheck,
  },
];

export function isCloudProviderId(id: unknown): id is CloudProviderId {
  return typeof id === "string" && CLOUD_PROVIDERS.some((p) => p.id === id);
}

export function getCloudProvider(id: string): CloudProviderPreset | undefined {
  return CLOUD_PROVIDERS.find((p) => p.id === id);
}

/** Anthropic (and any usesAnthropicSdk preset) runs through the SDK, never the OpenAI-compat shim. */
export function isAnthropicProvider(id: CloudProviderId): boolean {
  return getCloudProvider(id)?.usesAnthropicSdk === true;
}

export function isValidHttpsUrl(url: string): boolean {
  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
}

function isLoopbackUrlHost(url: string): boolean {
  try {
    // URL().hostname keeps the brackets on an IPv6 literal ("[::1]"); isLoopbackIp expects "::1".
    const hostname = new URL(url).hostname.replace(/^\[|\]$/g, "");
    return isLoopbackIp(hostname);
  } catch {
    return false;
  }
}

/**
 * Validates a user-entered base URL for one preset: https always works;
 * http only for a preset that allows it (allowHttpLoopbackOnly), and only
 * when the host is loopback (localhost/127.0.0.1/[::1]).
 */
export function isValidCloudBaseUrl(url: string, preset: CloudProviderPreset | undefined): boolean {
  if (isValidHttpsUrl(url)) return true;
  if (!preset?.allowHttpLoopbackOnly) return false;
  try {
    return new URL(url).protocol === "http:" && isLoopbackUrlHost(url);
  } catch {
    return false;
  }
}

/**
 * Whether a draft targets the same endpoint as a saved config, so the saved
 * key may be reused for it: same provider and, for a preset with an editable
 * base URL, the same base URL.
 */
export function isSameCloudTarget(
  saved: { providerId: CloudProviderId; baseUrl?: string } | undefined,
  providerId: CloudProviderId,
  baseUrl?: string,
): boolean {
  if (!saved || saved.providerId !== providerId) return false;
  const preset = getCloudProvider(providerId);
  if (!preset?.editableBaseUrl) return true;
  const normalize = preset.usesAnthropicSdk ? normalizeAnthropicBaseUrl : normalizeOpenAiBaseUrl;
  return normalize(saved.baseUrl) === normalize(baseUrl);
}
