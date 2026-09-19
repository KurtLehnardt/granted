import Anthropic from "@anthropic-ai/sdk";
import { normalizeOpenAiBaseUrl } from "./baseUrl";

/**
 * LLM provider seam. `makeLlmClient()` returns something that walks and talks
 * like the Anthropic SDK client the app already uses — `client.messages.create(
 * { model, max_tokens, system, messages }, { signal })` returning
 * `{ content: [{ type:"text", text }], usage }` — so NO call site changes its
 * shape. Which backend it is depends on `LLM_PROVIDER`:
 *
 *   - unset / "anthropic" (default) → the real Anthropic SDK, byte-unchanged.
 *   - "ollama" / "openai" / "local" → any OpenAI-compatible /chat/completions
 *     endpoint (Ollama's `http://localhost:11434/v1` by default), so the whole
 *     reasoning path can run on a LOCAL model (gemma, qwen, llama…) with no API
 *     key and nothing leaving the machine.
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

function provider(): string {
  return (process.env.LLM_PROVIDER || "anthropic").toLowerCase();
}

/** True when a local / OpenAI-compatible backend is selected (not Anthropic). */
export function isLocalLlm(): boolean {
  return provider() !== "anthropic";
}

export interface LlmClientOptions {
  timeout?: number;
  maxRetries?: number;
}

export function makeLlmClient(opts: LlmClientOptions = {}): LlmClient {
  if (!isLocalLlm()) {
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) {
      throw new Error(
        "ANTHROPIC_API_KEY is not set. Add it to .env.local (or set LLM_PROVIDER=ollama to run on a local model).",
      );
    }
    return new Anthropic({ apiKey: key, timeout: opts.timeout, maxRetries: opts.maxRetries ?? 0 });
  }
  // OpenAI-compatible shim (Ollama et al.), cast to the Anthropic surface the app uses.
  return openAiCompatShim(opts) as unknown as LlmClient;
}

function openAiCompatShim(opts: LlmClientOptions): LlmClient {
  // Accept a bare host (e.g. http://localhost:11434) by auto-appending /v1 —
  // the OpenAI-compatible path all these servers use. See ./baseUrl.
  const base = normalizeOpenAiBaseUrl(process.env.LLM_BASE_URL || "http://localhost:11434/v1");
  const model = process.env.LOCAL_LLM_MODEL || "gemma4:latest";
  const apiKey = process.env.LLM_API_KEY || "local"; // Ollama ignores this
  const timeoutMs = opts.timeout ?? 120_000;

  return {
    messages: {
      // Signature-compatible with Anthropic's messages.create for the subset the
      // app uses: params.{model,max_tokens,system,messages}, options.{signal}.
      async create(params: any, options?: { signal?: AbortSignal }): Promise<any> {
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

        try {
          const res = await fetch(`${base}/chat/completions`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
            body: JSON.stringify({
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
            }),
            signal: ac.signal,
          });
          if (!res.ok) {
            const body = await res.text().catch(() => "");
            const hint = res.status === 404
              ? " — a 404 here usually means LLM_BASE_URL is missing the OpenAI-compatible path; it must end in /v1 (e.g. http://localhost:11434/v1)"
              : "";
            throw new Error(`Local LLM request failed (${res.status}) at ${base}: ${body.slice(0, 200)}${hint}`);
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
