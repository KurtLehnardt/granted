import Anthropic from "@anthropic-ai/sdk";
import { getCloudProvider, type CloudProviderId } from "./providers";
import { currentHostedFetch } from "./client";
import { normalizeOpenAiBaseUrl } from "./baseUrl";

function anthropicClient(apiKey: string, timeout: number, workspaceId?: string): Anthropic {
  return new Anthropic({
    apiKey,
    timeout,
    maxRetries: 0,
    fetch: currentHostedFetch() as any,
    ...(workspaceId ? { defaultHeaders: { "anthropic-workspace-id": workspaceId } } : {}),
  });
}

// Model discovery for the Settings model picker, and the shared "call the
// provider" logic behind /api/llm/test-key. Both only ever run loopback-side.

export type ProbeOutcome =
  | { ok: true }
  | { ok: false; kind: "invalid_key" | "rate_limited" | "network" | "other"; message: string };

// Redacts anything that looks like a secret before a provider's error message
// ever reaches the UI: the literal key we sent, plus any sk-/sk-ant- style
// token embedded in the message (e.g. a provider echoing back what it saw).
const SECRET_TOKEN_PATTERN = /\bsk-(?:ant-)?[A-Za-z0-9_-]{6,}\b/g;
const MAX_PROVIDER_MESSAGE_LENGTH = 300;

function sanitizeProviderMessage(message: string, key?: string): string {
  let out = message;
  if (key && key.length >= 6) out = out.split(key).join("[redacted]");
  out = out.replace(SECRET_TOKEN_PATTERN, "[redacted]");
  out = out.trim();
  if (out.length > MAX_PROVIDER_MESSAGE_LENGTH) out = `${out.slice(0, MAX_PROVIDER_MESSAGE_LENGTH)}…`;
  return out;
}

/** Nudges the user toward the fix when Anthropic's own message already explains it. */
function withWorkspaceHint(message: string): string {
  return /workspace/i.test(message) ? `${message} Add your Workspace ID below.` : message;
}

function anthropicRawMessage(err: InstanceType<typeof Anthropic.APIError>): string {
  const body: any = (err as any).error;
  const bodyMessage = body?.error?.message ?? body?.message;
  return typeof bodyMessage === "string" ? bodyMessage : err.message;
}

function describeAnthropicError(err: unknown, key?: string): ProbeOutcome {
  const status = err instanceof Anthropic.APIError ? err.status : undefined;
  if (status === 401 || status === 403) {
    return { ok: false, kind: "invalid_key", message: "That key didn't work. Double-check it and try again." };
  }
  if (status === 429) {
    return {
      ok: false,
      kind: "rate_limited",
      message: "The provider is rate-limiting requests right now. The key looks fine — try again shortly.",
    };
  }
  if (typeof status === "number" && status >= 500) {
    return {
      ok: false,
      kind: "other",
      message: "The provider's API is temporarily unavailable. The key looks fine — try again shortly.",
    };
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return { ok: false, kind: "network", message: "Couldn't reach the provider's API. Check your network connection and try again." };
  }
  // Any other 4xx (400, 402, 422, ...) — surface the provider's own message,
  // sanitized, instead of the generic "didn't work" (e.g. a key that's valid
  // but not scoped to a workspace, which needs a different fix from the user).
  if (typeof status === "number" && status >= 400 && status < 500 && status !== 404) {
    const raw = err instanceof Anthropic.APIError ? anthropicRawMessage(err) : "That key didn't work. Double-check it and try again.";
    return { ok: false, kind: "other", message: withWorkspaceHint(sanitizeProviderMessage(raw, key)) };
  }
  return { ok: false, kind: "other", message: "That key didn't work. Double-check it and try again." };
}

async function extractHttpErrorMessage(res: Response): Promise<string | undefined> {
  let text: string;
  try {
    text = await res.text();
  } catch {
    return undefined;
  }
  if (!text) return undefined;
  try {
    const json = JSON.parse(text);
    const msg = json?.error?.message ?? json?.error ?? json?.message;
    if (typeof msg === "string" && msg) return msg;
  } catch {
    /* not JSON — fall through to the raw text */
  }
  return text;
}

async function describeHttpStatus(status: number, res: Response, key?: string): Promise<ProbeOutcome> {
  if (status === 401 || status === 403) {
    return { ok: false, kind: "invalid_key", message: "That key didn't work. Double-check it and try again." };
  }
  if (status === 429) {
    return {
      ok: false,
      kind: "rate_limited",
      message: "The provider is rate-limiting requests right now. The key looks fine — try again shortly.",
    };
  }
  if (status >= 500) {
    return {
      ok: false,
      kind: "other",
      message: "The provider's API is temporarily unavailable. The key looks fine — try again shortly.",
    };
  }
  if (status === 404) {
    return { ok: false, kind: "other", message: "Endpoint not found — check the base URL." };
  }
  // Any other 4xx — surface the parsed provider error message, sanitized.
  const raw = await extractHttpErrorMessage(res);
  if (raw) return { ok: false, kind: "other", message: sanitizeProviderMessage(raw, key) };
  return { ok: false, kind: "other", message: "That key didn't work. Double-check it and try again." };
}

export interface CloudProbeParams {
  providerId: CloudProviderId;
  baseUrl?: string;
  key: string;
  model: string;
  /** Anthropic only: sent as the anthropic-workspace-id header when the key isn't scoped to a workspace. */
  anthropicWorkspaceId?: string;
}

/** One minimal request to confirm a key works, without spending more than necessary. */
export async function probeCloudKey(params: CloudProbeParams): Promise<ProbeOutcome> {
  if (params.providerId === "anthropic") {
    try {
      // A models list, not a completion: costs no credit and doesn't depend
      // on `params.model` being a real model (a mistyped model would 404 a
      // messages.create call and get misreported as "the key didn't work").
      await anthropicClient(params.key, 15_000, params.anthropicWorkspaceId).models.list();
      return { ok: true };
    } catch (err) {
      return describeAnthropicError(err, params.key);
    }
  }

  const preset = getCloudProvider(params.providerId);
  const rawBaseUrl = preset?.baseUrl ?? params.baseUrl;
  if (!rawBaseUrl) return { ok: false, kind: "other", message: "No base URL is configured for this provider." };
  const baseUrl = normalizeOpenAiBaseUrl(rawBaseUrl);

  try {
    const res = await fetch(`${baseUrl}${preset?.keyProbePath ?? "/models"}`, {
      headers: { Authorization: `Bearer ${params.key}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return await describeHttpStatus(res.status, res, params.key);
    return { ok: true };
  } catch {
    return { ok: false, kind: "network", message: "Couldn't reach the provider's API. Check your network connection and try again." };
  }
}

export interface ModelsListResult {
  models?: string[];
  error?: string;
}

/** Populates the model picker: GET {base}/models for OpenAI-compatible providers, the Anthropic models list otherwise. */
export async function listCloudModels(params: {
  providerId: CloudProviderId;
  baseUrl?: string;
  key: string;
  anthropicWorkspaceId?: string;
}): Promise<ModelsListResult> {
  if (params.providerId === "anthropic") {
    try {
      const page: any = await anthropicClient(params.key, 10_000, params.anthropicWorkspaceId).models.list();
      const models = (page?.data ?? []).map((m: any) => m.id).filter((id: unknown) => typeof id === "string");
      return { models };
    } catch (err) {
      const outcome = describeAnthropicError(err, params.key);
      return { error: outcome.ok ? undefined : outcome.message };
    }
  }

  const preset = getCloudProvider(params.providerId);
  const rawBaseUrl = preset?.baseUrl ?? params.baseUrl;
  if (!rawBaseUrl) return { error: "No base URL is configured for this provider." };
  const baseUrl = normalizeOpenAiBaseUrl(rawBaseUrl);

  try {
    const res = await fetch(`${baseUrl}/models`, {
      headers: { Authorization: `Bearer ${params.key}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      const outcome = await describeHttpStatus(res.status, res, params.key);
      return { error: outcome.ok ? undefined : outcome.message };
    }
    const json: any = await res.json();
    const list = Array.isArray(json?.data) ? json.data : Array.isArray(json?.models) ? json.models : [];
    const models = list.map((m: any) => (typeof m === "string" ? m : m?.id)).filter((id: unknown) => typeof id === "string");
    return { models };
  } catch {
    return { error: "Couldn't reach the provider's API. Check your network connection and try again." };
  }
}
