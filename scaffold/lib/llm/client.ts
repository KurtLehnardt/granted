import { AsyncLocalStorage } from "node:async_hooks";
import Anthropic from "@anthropic-ai/sdk";
import { normalizeOpenAiBaseUrl } from "./baseUrl";
import { currentLocalModel } from "./modelContext";
import { configuredLocalModel, resolveLocalDefaultModel } from "./localDefault";
import { resolveProvider, resolveCloudConfig, resolveCloudApiKey, resolveCloudBaseUrl, resolveCloudModel, resolveAnthropicSdkBaseUrl } from "./config";
import { getCloudProvider, type CloudProviderPreset } from "./providers";
import { ProviderHttpError, redactKey, retryAfterMsFromResponse } from "./errors";
import { withRetry429, withConcurrencyLimit, getSharedLimiter } from "./rateLimit";

/** Test-only: the SDK binds node-fetch at import, so hosted tests inject fetch here. */
const hostedFetchAls = new AsyncLocalStorage<typeof fetch>();
export function withHostedFetch<T>(fetchImpl: typeof fetch | undefined, fn: () => T): T {
  return fetchImpl ? hostedFetchAls.run(fetchImpl, fn) : fn();
}
/** The fetch impl tests inject via withHostedFetch, for any other Anthropic SDK client construction (e.g. cloudModels.ts's probe/models-list). */
export function currentHostedFetch(): typeof fetch | undefined {
  return hostedFetchAls.getStore();
}

/**
 * LLM provider seam. `makeLlmClient()` returns something that walks and talks
 * like the Anthropic SDK client the app already uses — `client.messages.create(
 * { model, max_tokens, system, messages }, { signal })` returning
 * `{ content: [{ type:"text", text }], usage }` — so NO call site changes its
 * shape. Which backend it is depends on Settings' Local/Cloud switch
 * (data/local/llm-config.json, see ./config) or, absent that, env:
 *
 *   - unset / "anthropic" (default) → the real Anthropic SDK, byte-unchanged.
 *   - "ollama" / "openai" / "local" (LLM_PROVIDER) → any OpenAI-compatible
 *     /chat/completions endpoint (Ollama's `http://localhost:11434/v1` by
 *     default), so the whole reasoning path can run on a LOCAL model with no
 *     API key and nothing leaving the machine.
 *   - Settings' Cloud switch → a chosen cloud provider (see ./providers):
 *     Anthropic via the SDK, or any OpenAI-compatible preset (OpenAI, Gemini,
 *     OpenRouter, Groq, Mistral, or a user-entered "Other" base URL) via the
 *     same OpenAI-compat shim, with the resolved key as a bearer token.
 *
 * The corpus still needs matching embeddings — see lib/embed.ts, which has the
 * same env-driven base-URL seam for a local embedder.
 *
 * Env:
 *   LLM_PROVIDER       anthropic | ollama | openai | local   (default anthropic)
 *   LLM_BASE_URL       OpenAI-compatible base   (default http://localhost:11434/v1)
 *   LOCAL_LLM_MODEL    model name at that endpoint   (default gemma4:latest)
 *   LLM_API_KEY        bearer token for the endpoint, if it needs one (Ollama ignores it)
 */

export type LlmClient = Pick<Anthropic, "messages">;

/**
 * Runtime-config-first: data/local/llm-config.json (Settings' Local/Cloud
 * switch), written by POST /api/llm/config, takes precedence over the env var
 * below — see ./config. Absent file = today's env-only behavior.
 */
function provider(): "ollama" | "cloud" {
  return resolveProvider();
}

/** The configured local default (LOCAL_LLM_MODEL, else gemma4:latest), installed or not —
 * calls resolve the model that actually runs with resolveLocalDefaultModel (./localDefault). */
export function defaultLocalModel(): string {
  return configuredLocalModel();
}

/** True when the local / OpenAI-compatible self-hosted backend is selected (not any cloud provider). */
export function isLocalLlm(): boolean {
  return provider() === "ollama";
}

/**
 * Candidates-per-scoring-batch for the CURRENT cloud provider: the preset's
 * `batchSize` (e.g. Groq/OpenRouter/FCC free-tier presets, gentler on
 * tokens-per-minute) when set, else `hostedDefault`. Callers apply this only
 * on the hosted (non-local) path — local already has its own much smaller
 * batch size for JSON-object-mode reasons unrelated to rate limits.
 */
export function cloudBatchSize(hostedDefault: number): number {
  const cfg = resolveCloudConfig();
  const providerId = cfg?.providerId ?? "anthropic";
  return getCloudProvider(providerId)?.batchSize ?? hostedDefault;
}

export interface LlmClientOptions {
  timeout?: number;
  maxRetries?: number;
}

export function makeLlmClient(opts: LlmClientOptions = {}): LlmClient {
  if (isLocalLlm()) {
    return makeOpenAiCompatClient({
      baseUrl: normalizeOpenAiBaseUrl(process.env.LLM_BASE_URL || "http://localhost:11434/v1"),
      apiKey: process.env.LLM_API_KEY || "local", // Ollama ignores this
      // No model picked: the configured default if installed, else the best installed chat model.
      getModel: async () => currentLocalModel() || (await resolveLocalDefaultModel()),
      timeoutMs: opts.timeout ?? 120_000,
    });
  }

  const cfg = resolveCloudConfig();
  const providerId = cfg?.providerId ?? "anthropic";
  const resolved = resolveCloudApiKey(cfg);
  if (!resolved.key) {
    throw new Error(
      `${resolved.error ?? "No cloud API key is configured."} Fix it in Settings → Model (or switch to Local to run on a local model).`,
    );
  }

  const preset = getCloudProvider(providerId);
  if (preset?.usesAnthropicSdk) {
    const baseUrl = cfg ? resolveAnthropicSdkBaseUrl(cfg) : undefined;
    const client = makeAnthropicClientForKey(resolved.key, opts, { baseUrl, authMode: preset.authMode });
    const model = cfg ? resolveCloudModel(cfg) : undefined;
    const withModel = model ? withAnthropicModelOverride(client, model) : client;
    const limiter = preset.concurrency ? getSharedLimiter(concurrencyKey(providerId, baseUrl), preset.concurrency) : undefined;
    return withConcurrencyLimit(withRetry429(withModel), preset.concurrency, limiter);
  }

  const baseUrl = cfg ? resolveCloudBaseUrl(cfg) : undefined;
  if (!baseUrl) throw new Error("No base URL is configured for this cloud provider.");
  const model = cfg ? resolveCloudModel(cfg) : undefined;
  if (!model) throw new Error("No model is selected for this cloud provider.");

  const shim = makeOpenAiCompatClient({
    baseUrl,
    apiKey: resolved.key,
    getModel: () => currentLocalModel() || model,
    timeoutMs: opts.timeout ?? 120_000,
  });
  const limiter = preset?.concurrency ? getSharedLimiter(concurrencyKey(providerId, baseUrl), preset.concurrency) : undefined;
  return withConcurrencyLimit(withRetry429(shim), preset?.concurrency, limiter);
}

/** Shares one concurrency cap across every `makeLlmClient()` call that targets
 * the same provider + base URL — a per-call limiter would otherwise start
 * empty each time and never actually cap the app's real parallel fan-out
 * (lib/claude.ts, apply/draft.ts, apply/requirements.ts, competitors/analyze.ts
 * all construct a new client per batch/call). */
function concurrencyKey(providerId: string, baseUrl?: string): string {
  return `${providerId}|${baseUrl ?? ""}`;
}

/** Anthropic client for an explicit key — used by the test-key endpoint, which
 * may be validating a not-yet-saved key rather than the resolved config.
 * `baseUrl`/`authMode` support a usesAnthropicSdk preset other than the real Anthropic API
 * (e.g. the FCC proxy: a custom baseUrl, credential sent as `authToken` -> Authorization: Bearer). */
export function makeAnthropicClientForKey(
  apiKey: string,
  opts: LlmClientOptions = {},
  provider?: { baseUrl?: string; authMode?: CloudProviderPreset["authMode"] },
): Anthropic {
  return new Anthropic({
    // Explicit `null` on the unused credential, not just omission: the SDK
    // defaults apiKey from ANTHROPIC_API_KEY when unset, and authHeaders()
    // prefers x-api-key over Authorization: Bearer — so with both present
    // (e.g. ANTHROPIC_API_KEY set in the environment for the real Anthropic
    // API) an authToken-mode client would silently send the paid key instead
    // of the proxy token.
    ...(provider?.authMode === "authToken" ? { apiKey: null, authToken: apiKey } : { apiKey, authToken: null }),
    ...(provider?.baseUrl ? { baseURL: provider.baseUrl } : {}),
    timeout: opts.timeout,
    maxRetries: opts.maxRetries ?? 0,
    fetch: hostedFetchAls.getStore() as any,
  });
}

/** Overrides `model` on every request — used when the user picked a non-default model for the Anthropic path. */
function withAnthropicModelOverride(client: Anthropic, model: string): LlmClient {
  return {
    messages: {
      create: (params: any, options?: any) => client.messages.create({ ...params, model }, options),
    },
  } as unknown as LlmClient;
}

type ChatPayload = Record<string, unknown>;

/** Newer OpenAI models (o-series, gpt-5) reject `max_tokens` and `temperature: 0`; retry in their dialect. */
export function adaptRejectedParams(payload: ChatPayload, errorBody: string): ChatPayload | undefined {
  const { max_tokens, temperature, ...rest } = payload;
  if (max_tokens !== undefined && errorBody.includes("max_completion_tokens")) {
    return { ...rest, ...(temperature !== undefined ? { temperature } : {}), max_completion_tokens: max_tokens };
  }
  if (temperature !== undefined && errorBody.includes("temperature")) {
    return { ...rest, ...(max_tokens !== undefined ? { max_tokens } : {}) };
  }
  return undefined;
}

function makeOpenAiCompatClient(opts: {
  baseUrl: string;
  apiKey: string;
  getModel: () => string | Promise<string>;
  timeoutMs: number;
}): LlmClient {
  const { baseUrl, apiKey, getModel, timeoutMs } = opts;
  return {
    messages: {
      // Signature-compatible with Anthropic's messages.create for the subset the
      // app uses: params.{model,max_tokens,system,messages}, options.{signal}.
      async create(params: any, options?: { signal?: AbortSignal }): Promise<any> {
        const model = await getModel();
        const messages: Array<{ role: string; content: string }> = [];
        // `system` may be a plain string OR Anthropic content blocks
        // (`[{ type:"text", text, cache_control }]`, used for prompt caching).
        // Flatten either to text; cache_control is an Anthropic-only hint we drop.
        const systemText =
          typeof params.system === "string"
            ? params.system
            : Array.isArray(params.system)
              ? params.system.map((b: any) => b?.text ?? "").join("\n")
              : "";
        if (systemText) messages.push({ role: "system", content: systemText });
        for (const m of params.messages ?? []) {
          const content =
            typeof m.content === "string"
              ? m.content
              : Array.isArray(m.content)
                ? m.content.map((b: any) => b?.text ?? "").join("")
                : String(m.content ?? "");
          messages.push({ role: m.role === "assistant" ? "assistant" : "user", content });
        }

        // Own timeout (mirrors the Anthropic client's `timeout`) + the caller's signal.
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(new Error("timeout")), timeoutMs);
        if (options?.signal) {
          if (options.signal.aborted) ac.abort(options.signal.reason);
          else options.signal.addEventListener("abort", () => ac.abort(options.signal!.reason), { once: true });
        }

        let payload: ChatPayload = {
          model,
          messages,
          max_tokens: params.max_tokens,
          temperature: 0, // deterministic-ish scoring
          stream: false,
          // Grammar-constrained valid JSON. Every prompt here asks for JSON,
          // and small local models otherwise drift into malformed output the
          // repair layer can't recover. (Object mode wraps a bare array as
          // {"key":[...]}; parseJson unwraps that — see lib/claude.ts.)
          response_format: { type: "json_object" },
        };
        const post = (body: ChatPayload) =>
          fetch(`${baseUrl}/chat/completions`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
            body: JSON.stringify(body),
            signal: ac.signal,
          });

        try {
          let res = await post(payload);
          let body = "";
          for (let retries = 0; !res.ok; retries++) {
            body = await res.text().catch(() => "");
            const adapted = res.status === 400 && retries < 2 ? adaptRejectedParams(payload, body) : undefined;
            if (!adapted) break;
            payload = adapted;
            res = await post(payload);
          }
          if (!res.ok) {
            const hint = res.status === 404
              ? " — a 404 here usually means the base URL is missing the OpenAI-compatible path; it must end in /v1 (e.g. http://localhost:11434/v1)"
              : "";
            const safeBody = redactKey(body, apiKey);
            throw new ProviderHttpError(
              res.status,
              safeBody,
              `LLM request failed (${res.status}) at ${baseUrl}: ${safeBody.slice(0, 200)}${hint}`,
              retryAfterMsFromResponse(res),
            );
          }
          const json: any = await res.json();
          const text: string = json?.choices?.[0]?.message?.content ?? "";
          const usage = json?.usage ?? {};
          // Anthropic-shaped response — exactly what every call site reads.
          return {
            id: json?.id ?? "local",
            model,
            content: [{ type: "text", text }],
            usage: {
              input_tokens: usage.prompt_tokens ?? 0,
              output_tokens: usage.completion_tokens ?? 0,
              cache_creation_input_tokens: null,
              cache_read_input_tokens: null,
            },
          };
        } finally {
          clearTimeout(timer);
        }
      },
    },
  } as unknown as LlmClient;
}
