/**
 * lib/metering/pricing.ts — R4b cost measurement: per-model $/token price table.
 *
 * The product spec's §5.2 (cost ceiling) and the R4b task ("profile before
 * optimizing") both need real dollar figures before anything downstream
 * (`RunBudget` enforcement, latency/cost tradeoffs) can be calibrated
 * sensibly. This module is intentionally tiny and dependency-free: a price
 * table plus a pure lookup/cost-calc function. No framework imports, no
 * network calls — `lib/metering/meter.ts` is the thing that calls this per
 * recorded API call.
 *
 * Keyed by the EXACT model-id string each call site uses today:
 *   - `lib/claude.ts`'s `MODEL` constant: "claude-sonnet-4-6"
 *   - `lib/embed.ts`'s `MODEL` constant: "text-embedding-3-small"
 *
 * ---------------------------------------------------------------------------
 * SOURCES (retrieved 2026-10-10 — see PRICING_AS_OF below):
 *
 *   - Anthropic — https://platform.claude.com/docs/en/about-claude/pricing
 *     ("Model pricing" table), re-verified 2026-10-10. The table lists
 *     "Claude Sonnet 4.6" as its own row — an EXACT name/id match for
 *     `claude-sonnet-4-6`, so no substitution was needed: Base Input Tokens
 *     $3 / MTok, Output Tokens $15 / MTok (unchanged since the 2026-08-15
 *     retrieval). The same table's "Claude Haiku 4.5" row is also unchanged:
 *     Base Input $1 / MTok, Output $5 / MTok. That table also carries the
 *     5m-cache-write / 1h-cache-write / cache-hit columns used to verify
 *     `CACHE_WRITE_MULTIPLIER` / `CACHE_READ_MULTIPLIER` below: for both
 *     Claude Sonnet 4.6 and Claude Haiku 4.5 the 5-minute cache write is
 *     exactly 1.25x base input, the 1-hour cache write is exactly 2x base
 *     input, and the cache-hit price is exactly 0.1x base input — the
 *     "standard" multipliers that apply to all current models except two
 *     named exceptions (Claude Fable 5.1 and Claude Mythos 5.1, at a cheaper
 *     0.025x cache-hit rate), neither of which this app uses.
 *
 *   - OpenAI — https://platform.openai.com/docs/pricing redirects (301) to
 *     https://developers.openai.com/api/docs/pricing, re-verified 2026-10-10.
 *     "text-embedding-3-small" is unchanged at $0.02 / 1M tokens,
 *     with no separate output-token price: embeddings requests have no
 *     generated/output tokens to bill — a query embedding's entire cost is
 *     its input (prompt) tokens. The same page's "gpt-4o-mini" row (standard,
 *     non-batch tier) gives Input $0.15 / MTok, Output $0.60 / MTok — this is
 *     a NEW entry added 2026-10-10 for the "openai" cloud-provider preset's
 *     fixed default model (lib/llm/providers.ts).
 *
 *   - Google Gemini — https://ai.google.dev/gemini-api/docs/pricing, checked
 *     2026-10-10: "gemini-2.0-flash" is NOT listed on the live pricing page
 *     (third-party sources report it was shut down 2026-06-01). Per this
 *     file's own unpriced-model policy, no number was invented — see the
 *     comment above the omitted entry below. UNRESOLVED as of 2026-10-10.
 *
 *   - Groq — https://groq.com/pricing/, checked 2026-10-10: the live page
 *     renders no model/price table (client-rendered, nothing in static
 *     HTML). Groq's own docs at https://console.groq.com/docs/models list
 *     "llama-3.3-70b-versatile" with price "Contact Sales" — no public
 *     per-token rate (third-party sources report it moved to an
 *     enterprise-only tier around 2026-08-26). No number was invented — see
 *     the comment above the omitted entry below. UNRESOLVED as of 2026-10-10.
 *
 *   - Anthropic prompt-caching mechanics —
 *     https://platform.claude.com/docs/en/build-with-claude/prompt-caching,
 *     re-verified 2026-10-10, confirms in prose: "5-minute cache write
 *     tokens are 1.25 times the base input tokens price, 1-hour cache write
 *     tokens are 2 times the base input tokens price, and cache read tokens
 *     are 0.1 times the base input tokens price." See `CACHE_WRITE_MULTIPLIER`
 *     / `CACHE_READ_MULTIPLIER` below.
 *
 * THIS TABLE WILL GO STALE. That's expected, not a bug — it's why this
 * comment (source + retrieval date) matters more than the numbers do. When
 * updating: re-fetch the URLs above, update the entries below, and bump
 * `PRICING_AS_OF` to the new retrieval date. `SearchCostDebug.pricingAsOf`
 * (lib/metering/meter.ts) carries this date onto every logged/attached
 * summary, so a stale-price search is always traceable after the fact.
 * ---------------------------------------------------------------------------
 */

/** The date the numbers in PRICE_TABLE were last verified against the source pages above. */
export const PRICING_AS_OF = "2026-10-10";

export interface ModelPrice {
  /** $ per input token (i.e. price-per-million / 1,000,000). */
  inputPerToken: number;
  /**
   * $ per output token. Omitted for models with no output-token cost (e.g.
   * embeddings models bill input/prompt tokens only — there is nothing
   * "generated" to price).
   */
  outputPerToken?: number;
}

export const PRICE_TABLE: Record<string, ModelPrice> = {
  "claude-sonnet-4-6": {
    inputPerToken: 3 / 1_000_000, // $3 / MTok
    outputPerToken: 15 / 1_000_000, // $15 / MTok
  },
  // Claude Haiku 4.5 — the cheap-model route for `profile_extraction`
  // (lib/claude.ts CHEAP_MODEL). Anthropic pricing page (re-verified 2026-10-10,
  // unchanged since 2026-08-15): Base Input $1 / MTok, Output $5 / MTok.
  "claude-haiku-4-5-20251001": {
    inputPerToken: 1 / 1_000_000, // $1 / MTok
    outputPerToken: 5 / 1_000_000, // $5 / MTok
  },
  "text-embedding-3-small": {
    inputPerToken: 0.02 / 1_000_000, // $0.02 / MTok
    // No outputPerToken: embeddings have no output tokens.
  },
  // gpt-4o-mini — the "openai" cloud-provider preset's fixed default model
  // (lib/llm/providers.ts). OpenAI pricing page (retrieved 2026-10-10):
  // Input $0.15 / MTok, Output $0.60 / MTok.
  "gpt-4o-mini": {
    inputPerToken: 0.15 / 1_000_000, // $0.15 / MTok
    outputPerToken: 0.6 / 1_000_000, // $0.60 / MTok
  },
  // gemini-2.0-flash — the "google" cloud-provider preset's fixed default
  // model (lib/llm/providers.ts) — is DELIBERATELY OMITTED. Checked
  // https://ai.google.dev/gemini-api/docs/pricing on 2026-10-10: the model is
  // not listed on Google's live pricing page (reported shut down 2026-06-01).
  // Price could not be verified as of 2026-10-10 — do not invent a number;
  // the unpriced-$0 fallback below is the correct behavior until this is
  // re-checked against a live, current source.
  //
  // llama-3.3-70b-versatile — the "groq" cloud-provider preset's fixed
  // default model (lib/llm/providers.ts) — is DELIBERATELY OMITTED. Checked
  // https://groq.com/pricing/ and https://console.groq.com/docs/models on
  // 2026-10-10: Groq's own docs show this model's price as "Contact Sales"
  // with no public per-token rate (reported moved to an enterprise-only tier
  // around 2026-08-26). Price could not be verified as of 2026-10-10 — do
  // not invent a number; the unpriced-$0 fallback below is the correct
  // behavior until this is re-checked against a live, current source.
  //
  // The "fcc" preset's model label is intentionally never priced here: its
  // real backing model (and therefore its real cost) is unknown — it's a
  // free-provider proxy — so the unpriced-$0 fallback is the correct and
  // only honest answer for it.
};

/**
 * Prompt-caching cost multipliers, applied against a model's own
 * `inputPerToken` rate. Prompt caching IS in active use in this app:
 * `lib/claude.ts` sets `system: [{ type: "text", text: SYSTEM, cache_control:
 * { type: "ephemeral" } }]` at three live call sites, and none of them pass
 * an explicit `ttl`, which means every cache write made by this app uses
 * Anthropic's default 5-minute TTL, not the 1-hour TTL. Anthropic's
 * documented cache economics (confirmed against
 * https://platform.claude.com/docs/en/build-with-claude/prompt-caching and
 * https://platform.claude.com/docs/en/about-claude/pricing, both re-fetched
 * 2026-10-10) are: a cache write at the 5-minute TTL costs 1.25 times the
 * base input rate, a cache write at the 1-hour TTL costs 2 times the base
 * input rate, and a cache read (a cache hit or refresh) costs 0.1 times the
 * base input rate. Because this app's call sites only ever use the
 * 5-minute TTL today, `CACHE_WRITE_MULTIPLIER` below is 1.25, not the 2x
 * that would apply to a 1-hour TTL. If any call site in `lib/claude.ts` ever
 * adds `ttl: "1h"` to its `cache_control`, this constant (and this comment)
 * will need to be revisited — pricing would then depend on which TTL that
 * particular call used, which this module does not currently distinguish.
 */
export const CACHE_WRITE_MULTIPLIER = 1.25;
/** See the comment on `CACHE_WRITE_MULTIPLIER` above — this is the "cache
 *  read" (cache hit/refresh) multiplier, 0.1x the model's base input rate. */
export const CACHE_READ_MULTIPLIER = 0.1;

export interface PriceResult {
  /** Dollar cost of the given token counts under PRICE_TABLE's rate for `model`. */
  costUsd: number;
  /**
   * True when `model` had no PRICE_TABLE entry — `costUsd` is `0` in that
   * case (never a guessed/invented number). A `console.warn` is also emitted
   * so an unpriced model is visible in logs, not just silently zeroed.
   */
  unpriced: boolean;
}

/**
 * Models we've already warned about in this process — see `priceUsage`'s
 * dedup note below. Module-level so it persists across calls for the life of
 * the process (a fresh process, e.g. a new test file, gets a clean slate).
 */
const warnedUnpricedModels = new Set<string>();

/**
 * Pure cost calculation for one call's token counts. Never throws: an
 * unrecognized `model` id degrades to `{ costUsd: 0, unpriced: true }` with a
 * warning, rather than mispricing (e.g. falling back to some other model's
 * rate) or crashing the caller. `lib/metering/meter.ts`'s `record()` relies
 * on that guarantee to stay defensive itself.
 *
 * The warning fires at most once per distinct unpriced `model` id per
 * process: a legitimately free local model (e.g. an Ollama model run through
 * the local-model path) is otherwise correct at $0/call but would spam the
 * log once per LLM call — the dedup keeps the signal (an unpriced model
 * showed up) without the noise.
 *
 * Cache-token fields (`cache_creation_input_tokens` / `cache_read_input_tokens`)
 * ARE now priced here, via the two optional trailing parameters below.
 * Prompt caching is in active use — see the comment on `StageCost` in
 * `lib/metering/meter.ts` and the comment on `CACHE_WRITE_MULTIPLIER` above
 * for the full explanation and sources. A cache-creation token is priced at
 * `CACHE_WRITE_MULTIPLIER` (1.25x) and a cache-read token at
 * `CACHE_READ_MULTIPLIER` (0.1x) of the model's own `inputPerToken` rate.
 * Both parameters are optional and default to 0, so every pre-existing
 * 3-argument call site keeps compiling and pricing identically to before.
 */
export function priceUsage(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cacheCreationTokens?: number,
  cacheReadTokens?: number,
): PriceResult {
  const price = PRICE_TABLE[model];
  if (!price) {
    if (!warnedUnpricedModels.has(model)) {
      warnedUnpricedModels.add(model);
      console.warn(
        `[metering] no PRICE_TABLE entry for model "${model}" — costUsd defaulting to 0. ` +
          `Add a priced entry to lib/metering/pricing.ts if this model is now in real use. ` +
          `(This warning is logged once per model per process.)`,
      );
    }
    return { costUsd: 0, unpriced: true };
  }
  const safeIn = Number.isFinite(inputTokens) ? inputTokens : 0;
  const safeOut = Number.isFinite(outputTokens) ? outputTokens : 0;
  const safeCacheCreation = cacheCreationTokens != null && Number.isFinite(cacheCreationTokens) ? cacheCreationTokens : 0;
  const safeCacheRead = cacheReadTokens != null && Number.isFinite(cacheReadTokens) ? cacheReadTokens : 0;
  const costUsd =
    safeIn * price.inputPerToken +
    safeOut * (price.outputPerToken ?? 0) +
    safeCacheCreation * price.inputPerToken * CACHE_WRITE_MULTIPLIER +
    safeCacheRead * price.inputPerToken * CACHE_READ_MULTIPLIER;
  return { costUsd, unpriced: false };
}
