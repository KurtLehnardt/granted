import Anthropic from "@anthropic-ai/sdk";
import { getCloudProvider, type CloudProviderId } from "./providers";
import { currentHostedFetch } from "./client";

function anthropicClient(apiKey: string, timeout: number): Anthropic {
  return new Anthropic({ apiKey, timeout, maxRetries: 0, fetch: currentHostedFetch() as any });
}

// Model discovery for the Settings model picker, and the shared "call the
// provider" logic behind /api/llm/test-key. Both only ever run loopback-side.

export type ProbeOutcome =
  | { ok: true }
  | { ok: false; kind: "invalid_key" | "rate_limited" | "network" | "other"; message: string };

function describeAnthropicError(err: unknown): ProbeOutcome {
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
  return { ok: false, kind: "other", message: "That key didn't work. Double-check it and try again." };
}

function describeHttpStatus(status: number): ProbeOutcome {
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
  return { ok: false, kind: "other", message: "That key didn't work. Double-check it and try again." };
}

export interface CloudProbeParams {
  providerId: CloudProviderId;
  baseUrl?: string;
  key: string;
  model: string;
}

/** One minimal request to confirm a key works, without spending more than necessary. */
export async function probeCloudKey(params: CloudProbeParams): Promise<ProbeOutcome> {
  if (params.providerId === "anthropic") {
    try {
      // A models list, not a completion: costs no credit and doesn't depend
      // on `params.model` being a real model (a mistyped model would 404 a
      // messages.create call and get misreported as "the key didn't work").
      await anthropicClient(params.key, 15_000).models.list();
      return { ok: true };
    } catch (err) {
      return describeAnthropicError(err);
    }
  }

  const preset = getCloudProvider(params.providerId);
  const baseUrl = preset?.baseUrl ?? params.baseUrl;
  if (!baseUrl) return { ok: false, kind: "other", message: "No base URL is configured for this provider." };

  try {
    const res = await fetch(`${baseUrl}/models`, {
      headers: { Authorization: `Bearer ${params.key}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return describeHttpStatus(res.status);
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
export async function listCloudModels(params: { providerId: CloudProviderId; baseUrl?: string; key: string }): Promise<ModelsListResult> {
  if (params.providerId === "anthropic") {
    try {
      const page: any = await anthropicClient(params.key, 10_000).models.list();
      const models = (page?.data ?? []).map((m: any) => m.id).filter((id: unknown) => typeof id === "string");
      return { models };
    } catch (err) {
      const outcome = describeAnthropicError(err);
      return { error: outcome.ok ? undefined : outcome.message };
    }
  }

  const preset = getCloudProvider(params.providerId);
  const baseUrl = preset?.baseUrl ?? params.baseUrl;
  if (!baseUrl) return { error: "No base URL is configured for this provider." };

  try {
    const res = await fetch(`${baseUrl}/models`, {
      headers: { Authorization: `Bearer ${params.key}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      const outcome = describeHttpStatus(res.status);
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
