// Cloud provider registry. Anthropic runs through the real SDK (see client.ts);
// every other preset is an OpenAI-compatible endpoint reached through the
// existing OpenAI-compat shim, with the preset's base URL and a bearer key.

export type CloudProviderId =
  | "anthropic"
  | "openai"
  | "google"
  | "openrouter"
  | "groq"
  | "mistral"
  | "other";

export interface CloudProviderPreset {
  id: CloudProviderId;
  label: string;
  /** Fixed base URL for a preset provider. Undefined only for "other", which takes a user-entered URL. */
  baseUrl?: string;
  defaultModel?: string;
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
    isKeyValid: genericKeyCheck,
  },
  {
    id: "groq",
    label: "Groq",
    baseUrl: "https://api.groq.com/openai/v1",
    defaultModel: "llama-3.3-70b-versatile",
    isKeyValid: genericKeyCheck,
  },
  {
    id: "mistral",
    label: "Mistral",
    baseUrl: "https://api.mistral.ai/v1",
    isKeyValid: genericKeyCheck,
  },
  {
    id: "other",
    label: "Other (OpenAI-compatible)",
    isKeyValid: genericKeyCheck,
  },
];

export function isCloudProviderId(id: unknown): id is CloudProviderId {
  return typeof id === "string" && CLOUD_PROVIDERS.some((p) => p.id === id);
}

export function getCloudProvider(id: string): CloudProviderPreset | undefined {
  return CLOUD_PROVIDERS.find((p) => p.id === id);
}

/** Anthropic runs through the SDK, never the OpenAI-compat shim. */
export function isAnthropicProvider(id: CloudProviderId): boolean {
  return id === "anthropic";
}

export function isValidHttpsUrl(url: string): boolean {
  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
}
