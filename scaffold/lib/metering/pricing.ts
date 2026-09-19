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
 * SOURCES (retrieved 2026-08-15 — see PRICING_AS_OF below):
 *
 *   - Anthropic — https://platform.claude.com/docs/en/about-claude/pricing
 *     ("Model pricing" table). The table lists "Claude Sonnet 4.6" as its own
 *     row — an EXACT name/id match for `claude-sonnet-4-6`, so no substitution
 *     was needed: Base Input Tokens $3 / MTok, Output Tokens $15 / MTok.
 *
 *   - OpenAI — https://developers.openai.com/api/docs/pricing
 *     ("Specialized models" section, Standard tier). "text-embedding-3-small"
 *     is listed at $0.02 / 1M tokens, with no separate output-token price:
 *     embeddings requests have no generated/output tokens to bill — a query
 *     embedding's entire cost is its input (prompt) tokens.
 *
 * THIS TABLE WILL GO STALE. That's expected, not a bug — it's why this
 * comment (source + retrieval date) matters more than the numbers do. When
 * updating: re-fetch both URLs above, update the two entries below, and bump
 * `PRICING_AS_OF` to the new retrieval date. `SearchCostDebug.pricingAsOf`
 * (lib/metering/meter.ts) carries this date onto every logged/attached
 * summary, so a stale-price search is always traceable after the fact.
 * ---------------------------------------------------------------------------
 */

/** The date the numbers in PRICE_TABLE were last verified against the source pages above. */
export const PRICING_AS_OF = "2026-08-15";

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
  // (lib/claude.ts CHEAP_MODEL). Anthropic pricing page (retrieved 2026-08-15):
  // Base Input $1 / MTok, Output $5 / MTok.
  "claude-haiku-4-5-20251001": {
    inputPerToken: 1 / 1_000_000, // $1 / MTok
    outputPerToken: 5 / 1_000_000, // $5 / MTok
  },
  "text-embedding-3-small": {
    inputPerToken: 0.02 / 1_000_000, // $0.02 / MTok
    // No outputPerToken: embeddings have no output tokens.
  },
};

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
 * are intentionally NOT priced here — see the comment on `StageCost` in
 * `lib/metering/meter.ts`. Nothing in this app uses prompt caching yet, and
 * this function only ever sees plain input/output counts.
 */
export function priceUsage(model: string, inputTokens: number, outputTokens: number): PriceResult {
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
  const costUsd = safeIn * price.inputPerToken + safeOut * (price.outputPerToken ?? 0);
  return { costUsd, unpriced: false };
}
