import Anthropic from "@anthropic-ai/sdk";
import { getCloudProvider, type CloudProviderId, type CloudProviderPreset } from "./providers";
import { currentHostedFetch, adaptRejectedParams } from "./client";
import { normalizeOpenAiBaseUrl, normalizeAnthropicBaseUrl } from "./baseUrl";
import { sanitizeProviderMessage, anthropicRawMessage, providerMessageFromBody } from "./errors";

function anthropicClient(
  apiKey: string,
  timeout: number,
  provider?: { baseUrl?: string; authMode?: CloudProviderPreset["authMode"] },
): Anthropic {
  return new Anthropic({
    // See client.ts's makeAnthropicClientForKey for why both fields are set explicitly.
    ...(provider?.authMode === "authToken" ? { apiKey: null, authToken: apiKey } : { apiKey, authToken: null }),
    ...(provider?.baseUrl ? { baseURL: provider.baseUrl } : {}),
    timeout,
    maxRetries: 0,
    fetch: currentHostedFetch() as any,
  });
}

/** The Anthropic-SDK base URL for a usesAnthropicSdk preset: undefined for the real Anthropic API. */
function anthropicSdkBaseUrl(preset: CloudProviderPreset, draftBaseUrl?: string): string | undefined {
  const baseUrl = preset.editableBaseUrl ? (draftBaseUrl ?? preset.baseUrl) : preset.baseUrl;
  return baseUrl ? normalizeAnthropicBaseUrl(baseUrl) : undefined;
}

// Model discovery for the Settings model picker, and the shared "call the
// provider" logic behind /api/llm/test-key. Both only ever run loopback-side.

export type ProbeOutcome =
  | { ok: true }
  | { ok: false; kind: "invalid_key" | "rate_limited" | "network" | "other" | "invalid_model"; message: string };

/** Nudges the user toward the fix when Anthropic's own message says the key isn't scoped to a workspace. */
function withWorkspaceHint(message: string): string {
  return /workspace/i.test(message)
    ? `${message} This key isn't tied to a workspace. In the Anthropic Console, open a workspace (e.g. Default) and create the API key there.`
    : message;
}

/** A key can be valid and reach the provider, yet name a model that provider
 * doesn't have (mistyped, retired, wrong account tier) — that's not a key
 * problem, so it gets its own message instead of "that key didn't work". */
function modelNotAvailableMessage(model: string): string {
  return `The key works, but the model "${model}" isn't available. Choose a different model.`;
}

/** `model` is only needed to word the 404 case (Anthropic's "no such model")
 * — omitted for the key-only probe (models.list), where a 404 can't happen. */
function describeAnthropicError(err: unknown, key?: string, model?: string): ProbeOutcome {
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
  // Anthropic 404s a message call with an unrecognized model — that's the
  // model's fault, not the key's, so it gets its own kind/message.
  if (status === 404 && model) {
    return { ok: false, kind: "invalid_model", message: modelNotAvailableMessage(model) };
  }
  // Any other 4xx (400, 402, 422, ...) — surface the provider's own message,
  // sanitized, instead of the generic "didn't work" (e.g. a key that's valid
  // but not scoped to a workspace, which needs a different fix from the user).
  const raw = err instanceof Anthropic.APIError && status !== 404 ? anthropicRawMessage(err) : undefined;
  if (raw && typeof status === "number" && status >= 400 && status < 500) {
    return { ok: false, kind: "other", message: withWorkspaceHint(sanitizeProviderMessage(raw, key)) };
  }
  return { ok: false, kind: "other", message: "That key didn't work. Double-check it and try again." };
}

async function extractHttpErrorMessage(res: Response): Promise<string | undefined> {
  try {
    return providerMessageFromBody(await res.text());
  } catch {
    return undefined;
  }
}

/** `model`: when set, a 404 is worded as "this model isn't available" (a
 * chat-completions call for a bad model id) rather than "endpoint not found"
 * (a GET /models call against a wrong base URL) — same status, different cause. */
async function describeHttpStatus(status: number, res: Response, key?: string, model?: string): Promise<ProbeOutcome> {
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
    if (model) return { ok: false, kind: "invalid_model", message: modelNotAvailableMessage(model) };
    return { ok: false, kind: "other", message: "Endpoint not found — check the base URL." };
  }
  // Any other 4xx — surface the parsed provider error message, sanitized. An
  // OpenAI-shaped "model_not_found" (usually a 400/404) also gets the
  // model-specific wording instead of "that key didn't work".
  const raw = await extractHttpErrorMessage(res);
  if (model && raw && /model/i.test(raw) && /(not found|does not exist|no such|unknown model|invalid model)/i.test(raw)) {
    return { ok: false, kind: "invalid_model", message: modelNotAvailableMessage(model) };
  }
  if (raw) return { ok: false, kind: "other", message: sanitizeProviderMessage(raw, key) };
  return { ok: false, kind: "other", message: "That key didn't work. Double-check it and try again." };
}

export interface CloudProbeParams {
  providerId: CloudProviderId;
  baseUrl?: string;
  key: string;
  /** Configured model to probe. Falls back to the provider's default (or, if
   * it has none, the first model the list call above returned) when omitted. */
  model?: string;
}

/** Real-world finding: a key can pass `models.list` (free) yet have NO credit
 * on the account, so every actual search fails at Test key time with no
 * warning. One minimal (max_tokens: 1) message call after the list catches
 * that — billing, permissions, or a model the key can't use — before the user
 * ever runs a search on it. */
async function probeAnthropicModel(client: Anthropic, model: string, key: string): Promise<ProbeOutcome> {
  try {
    await client.messages.create({ model, max_tokens: 1, messages: [{ role: "user", content: "hi" }] });
    return { ok: true };
  } catch (err) {
    return describeAnthropicError(err, key, model);
  }
}

async function probeOpenAiCompatModel(baseUrl: string, key: string, model: string): Promise<ProbeOutcome> {
  let payload: Record<string, unknown> = { model, max_tokens: 1, messages: [{ role: "user", content: "hi" }] };
  const post = () =>
    fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15_000),
    });
  try {
    let res = await post();
    // Same dialect retry as the search shim (o-series/gpt-5 reject max_tokens).
    if (res.status === 400) {
      const text = await res.text().catch(() => "");
      const adapted = adaptRejectedParams(payload, text);
      if (!adapted) return await describeHttpStatus(400, new Response(text), key, model);
      payload = adapted;
      res = await post();
    }
    if (res.ok) return { ok: true };
    return await describeHttpStatus(res.status, res, key, model);
  } catch {
    return { ok: false, kind: "network", message: "Couldn't reach the provider's API. Check your network connection and try again." };
  }
}

/** Confirms a key works AND can actually run a search: a models list (free),
 * then one minimal message with the configured model — or the provider's
 * default/first listed model, if none was configured — so a credit/billing/
 * permission failure (which a bare models.list can't see) surfaces here
 * instead of at search time. */
export async function probeCloudKey(params: CloudProbeParams): Promise<ProbeOutcome> {
  const sdkPreset = getCloudProvider(params.providerId);
  if (sdkPreset?.usesAnthropicSdk) {
    const client = anthropicClient(params.key, 15_000, {
      baseUrl: anthropicSdkBaseUrl(sdkPreset, params.baseUrl),
      authMode: sdkPreset.authMode,
    });
    let models: string[] = [];
    try {
      const page: any = await client.models.list();
      models = (page?.data ?? []).map((m: any) => m.id).filter((id: unknown) => typeof id === "string");
    } catch (err) {
      return describeAnthropicError(err, params.key);
    }
    const model = params.model || sdkPreset.defaultModel || models[0];
    if (!model) return { ok: true }; // no model configured or listed — key alone is all we can confirm
    return probeAnthropicModel(client, model, params.key);
  }

  const preset = getCloudProvider(params.providerId);
  const rawBaseUrl = preset?.baseUrl ?? params.baseUrl;
  if (!rawBaseUrl) return { ok: false, kind: "other", message: "No base URL is configured for this provider." };
  const baseUrl = normalizeOpenAiBaseUrl(rawBaseUrl);

  let listedModels: string[] = [];
  try {
    const res = await fetch(`${baseUrl}${preset?.keyProbePath ?? "/models"}`, {
      headers: { Authorization: `Bearer ${params.key}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return await describeHttpStatus(res.status, res, params.key);
    // Only a real /models listing (not e.g. openrouter's /key probe) carries model ids.
    if (!preset?.keyProbePath) {
      try {
        const json: any = await res.json();
        const list = Array.isArray(json?.data) ? json.data : Array.isArray(json?.models) ? json.models : [];
        listedModels = list.map((m: any) => (typeof m === "string" ? m : m?.id)).filter((id: unknown) => typeof id === "string");
      } catch {
        /* body wasn't a models list — no model ids to fall back to */
      }
    }
  } catch {
    return { ok: false, kind: "network", message: "Couldn't reach the provider's API. Check your network connection and try again." };
  }

  const model = params.model || preset?.defaultModel || listedModels[0];
  if (!model) return { ok: true }; // no model configured, no default, none listed — key alone is all we can confirm
  return probeOpenAiCompatModel(baseUrl, params.key, model);
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
}): Promise<ModelsListResult> {
  const sdkPreset = getCloudProvider(params.providerId);
  if (sdkPreset?.usesAnthropicSdk) {
    try {
      const client = anthropicClient(params.key, 10_000, {
        baseUrl: anthropicSdkBaseUrl(sdkPreset, params.baseUrl),
        authMode: sdkPreset.authMode,
      });
      const page: any = await client.models.list();
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
