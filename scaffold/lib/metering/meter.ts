/**
 * lib/metering/meter.ts — R4b cost measurement: per-search usage capture,
 * cost calc, and structured-log emission.
 *
 * Pure/defensive — no framework imports (mirrors `lib/analytics/track.ts`'s
 * "a bad instrumentation call must never crash the app it's instrumenting"
 * philosophy exactly, applied to cost tracking instead of funnel events).
 *
 * Shape of the day: `lib/claude.ts`'s three Anthropic calls and
 * `lib/embed.ts`'s one OpenAI call each accept an OPTIONAL trailing `meter`
 * param and, immediately once their API call resolves (before any parsing
 * that could throw), normalize the provider's raw `usage` object into the
 * generic shape `record()` expects below and call it. `lib/match.ts` creates
 * one `CostMeter` per `buildOpportunityMap()` call, threads it through every
 * stage, always logs the structured summary line, and attaches the summary
 * to the response only when the `r4b_cost_debug` flag is on.
 *
 * NEVER THROWS. Every exported method here catches its own errors internally
 * and degrades silently (warn + drop that one data point) — a metering bug
 * must never be the reason a search fails. `lib/match.ts` additionally wraps
 * its own use of this module in try/catch, belt-and-suspenders.
 */

import { priceUsage, PRICING_AS_OF } from "./pricing";

/**
 * Who served a call. "builtin" is the in-process search model and "custom" a
 * self-hosted embedder: both cost nothing, and neither may be reported as OpenAI.
 */
export type MeterProvider = "anthropic" | "openai" | "builtin" | "custom";
const METER_PROVIDERS: readonly MeterProvider[] = ["anthropic", "openai", "builtin", "custom"];

/** One completed API call's usage, normalized to a provider-agnostic shape
 *  by the call site (`lib/claude.ts` / `lib/embed.ts`) before it reaches
 *  `record()`. This module never looks at a provider SDK's raw response. */
export interface MeterRecordInput {
  /**
   * Pipeline stage name. Reuses `lib/contracts/modelRouting.ts`'s `ModelTask`
   * string values where they overlap (`profile_extraction`,
   * `candidate_analysis`, `weak_field_explanation`), plus `query_embedding`
   * for the OpenAI embeddings call — not a `ModelTask` itself (that enum is
   * Anthropic-only), so this field is a plain string rather than the
   * contract's enum type.
   */
  stage: string;
  provider: MeterProvider;
  model: string;
  inputTokens: number;
  outputTokens: number;
  /**
   * Present only when prompt caching is active (it isn't, yet — see the
   * comment on `StageCost` below). Informational only.
   */
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
  /**
   * This ONE call's own wall-clock ms, timed tight around the API call
   * itself (not the surrounding function). For a stage that fans out into
   * several concurrent calls (`candidate_analysis`'s batches in
   * `explainMatches`), these accumulate by SUMMING across `record()` calls —
   * call `recordStageLatency()` once the fan-out completes to overwrite the
   * stage's total with the true concurrent wall-clock instead (summing
   * concurrent calls' latencies would overcount).
   */
  latencyMs: number;
}

/** One stage's aggregated cost/latency, as it appears in `SearchCostDebug.stages`. */
export interface StageCost {
  stage: string;
  provider: MeterProvider;
  model: string;
  inputTokens: number;
  outputTokens: number;
  /**
   * Cache token counts, summed across every `record()` call for this stage,
   * IF any call reported them. Nothing in this app uses prompt caching yet,
   * so these are expected to be `undefined` today — future-proofing for
   * R10.3's "cache hit/miss" (per the R4b task spec). Deliberately NOT part
   * of `costUsd`: `lib/metering/pricing.ts` has no cache-token rate, and
   * inventing one here would silently mismeter a feature that isn't in use.
   */
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
  /** Summed cost across every `record()` call aggregated into this stage. */
  costUsd: number;
  /** See `MeterRecordInput.latencyMs` for how this accumulates. */
  latencyMs: number;
  /** Number of underlying API calls rolled into this one stage entry. */
  calls: number;
}

/** The full per-search cost/latency breakdown `lib/match.ts` logs unconditionally
 *  and attaches to the response as `costDebug` only when `r4b_cost_debug` is on. */
export interface SearchCostDebug {
  stages: StageCost[];
  totalCostUsd: number;
  /** Wall-clock ms for the whole `buildOpportunityMap()` call (from `CostMeter`
   *  creation to `summary()` being called), not a sum of the stage latencies —
   *  non-LLM work (rules gating, eligibility screening, assembly) has wall-clock
   *  time too, and isn't a `record()`-ed stage. */
  totalLatencyMs: number;
  /** Copied from `lib/metering/pricing.ts`'s `PRICING_AS_OF` at summary time, so
   *  a logged/attached summary is always traceable to the price table that priced it. */
  pricingAsOf: string;
}

/** A per-search cost meter. Create one per `buildOpportunityMap()` call via
 *  `createCostMeter()`; thread it through every stage as an optional trailing
 *  param. Every method is safe to call even after a partial failure. */
export interface CostMeter {
  /** Record one completed API call's usage into its stage's running totals. */
  record(input: MeterRecordInput): void;
  /**
   * Overwrite a stage's total latency (e.g. after a concurrent fan-out
   * completes) instead of the sum `record()` would otherwise have produced.
   * A no-op (not an error) if `stage` hasn't had anything recorded yet.
   */
  recordStageLatency(stage: string, latencyMs: number): void;
  /** Produce the current `SearchCostDebug` snapshot. Safe to call more than
   *  once; safe to call with zero stages recorded (returns a well-formed
   *  empty result, not a throw). */
  summary(): SearchCostDebug;
  /** Emit the unconditional structured server log line for this search.
   *  Pass an already-computed `summary()` to avoid recomputing (and to keep
   *  the logged totals identical to whatever was attached as `costDebug`);
   *  omitted, it computes one itself. */
  logSummary(precomputed?: SearchCostDebug): void;
}

/** `Number(x)`, but never `NaN`/`Infinity` — malformed/undefined usage data
 *  degrades to `0` instead of corrupting a running total. */
function safeNumber(n: unknown): number {
  const v = typeof n === "number" ? n : Number(n);
  return Number.isFinite(v) ? v : 0;
}

/** `performance.now()` when available (Node 16+, all runtimes this app ships
 *  to), falling back to `Date.now()` — both are monotonic-enough wall-clock
 *  sources for this module's purposes. */
function now(): number {
  return typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();
}

/**
 * Create a fresh per-search `CostMeter`. `lib/match.ts` creates exactly one
 * of these near the top of `buildOpportunityMap()` and threads it through
 * every stage, including the `weakField()` early-exit path.
 */
export function createCostMeter(): CostMeter {
  const startedAt = now();
  const stages = new Map<string, StageCost>();

  function record(input: MeterRecordInput): void {
    try {
      if (!input || typeof input !== "object") return;

      const stageName = typeof input.stage === "string" && input.stage.length > 0 ? input.stage : "unknown";
      const provider: MeterProvider = METER_PROVIDERS.includes(input.provider) ? input.provider : "anthropic";
      const model = typeof input.model === "string" && input.model.length > 0 ? input.model : "unknown";
      const inputTokens = safeNumber(input.inputTokens);
      const outputTokens = safeNumber(input.outputTokens);
      const latencyMs = safeNumber(input.latencyMs);
      const cacheCreation =
        input.cacheCreationInputTokens != null ? safeNumber(input.cacheCreationInputTokens) : undefined;
      const cacheRead = input.cacheReadInputTokens != null ? safeNumber(input.cacheReadInputTokens) : undefined;

      const existing: StageCost = stages.get(stageName) ?? {
        stage: stageName,
        provider,
        model,
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        latencyMs: 0,
        calls: 0,
      };

      existing.provider = provider;
      existing.model = model;
      existing.inputTokens += inputTokens;
      existing.outputTokens += outputTokens;
      existing.latencyMs += latencyMs;
      existing.calls += 1;
      if (cacheCreation !== undefined) {
        existing.cacheCreationInputTokens = (existing.cacheCreationInputTokens ?? 0) + cacheCreation;
      }
      if (cacheRead !== undefined) {
        existing.cacheReadInputTokens = (existing.cacheReadInputTokens ?? 0) + cacheRead;
      }

      // Built-in and self-hosted embeddings are free whatever their token counts.
      const { costUsd } = provider === "builtin" || provider === "custom" ? { costUsd: 0 } : priceUsage(model, inputTokens, outputTokens);
      existing.costUsd += costUsd;

      stages.set(stageName, existing);
    } catch (err) {
      console.warn("[metering] record() failed — dropping this data point:", err);
    }
  }

  function recordStageLatency(stage: string, latencyMs: number): void {
    try {
      const existing = stages.get(stage);
      if (!existing) return; // nothing recorded yet for this stage — no-op, not an error.
      existing.latencyMs = safeNumber(latencyMs);
    } catch (err) {
      console.warn("[metering] recordStageLatency() failed:", err);
    }
  }

  function summary(): SearchCostDebug {
    try {
      const stageList = Array.from(stages.values());
      const totalCostUsd = stageList.reduce((sum, s) => sum + s.costUsd, 0);
      return {
        stages: stageList,
        totalCostUsd,
        totalLatencyMs: safeNumber(now() - startedAt),
        pricingAsOf: PRICING_AS_OF,
      };
    } catch (err) {
      console.warn("[metering] summary() failed — returning an empty summary:", err);
      return { stages: [], totalCostUsd: 0, totalLatencyMs: 0, pricingAsOf: PRICING_AS_OF };
    }
  }

  function logSummary(precomputed?: SearchCostDebug): void {
    try {
      const toLog = precomputed ?? summary();
      // No real logging backend yet (see track.ts's defaultSink for
      // precedent) — this is the R4b "profile before optimizing" baseline,
      // unconditional regardless of the r4b_cost_debug flag (that flag only
      // gates whether the SAME summary is attached to the API response).
      console.log("[cost]", JSON.stringify(toLog));
    } catch (err) {
      console.warn("[metering] logSummary() failed:", err);
    }
  }

  return { record, recordStageLatency, summary, logSummary };
}
