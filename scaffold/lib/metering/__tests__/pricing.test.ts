import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { priceUsage, PRICE_TABLE, PRICING_AS_OF, CACHE_WRITE_MULTIPLIER, CACHE_READ_MULTIPLIER } from "../pricing";

/**
 * R4b — pricing.ts: pure arithmetic against the documented PRICE_TABLE, plus
 * the "unrecognized model degrades safely" guarantee `meter.ts` relies on.
 */

describe("PRICE_TABLE — shape", () => {
  test("keyed by the exact two model ids in live use", () => {
    assert.ok(PRICE_TABLE["claude-sonnet-4-6"], "claude-sonnet-4-6 must be priced");
    assert.ok(PRICE_TABLE["text-embedding-3-small"], "text-embedding-3-small must be priced");
  });

  test("gpt-4o-mini (the 'openai' preset's default model) is priced", () => {
    const p = PRICE_TABLE["gpt-4o-mini"];
    assert.ok(p, "gpt-4o-mini must be priced");
    assert.equal(typeof p.inputPerToken, "number");
    assert.ok(p.inputPerToken > 0);
    assert.equal(typeof p.outputPerToken, "number");
    assert.ok((p.outputPerToken ?? 0) > 0);
  });

  test("gemini-2.0-flash and llama-3.3-70b-versatile remain unverified and absent (unpriced-$0 fallback applies)", () => {
    assert.equal(PRICE_TABLE["gemini-2.0-flash"], undefined);
    assert.equal(PRICE_TABLE["llama-3.3-70b-versatile"], undefined);
  });

  test("PRICING_AS_OF is a non-empty date-ish string", () => {
    assert.equal(typeof PRICING_AS_OF, "string");
    assert.ok(PRICING_AS_OF.length > 0);
    assert.match(PRICING_AS_OF, /^\d{4}-\d{2}-\d{2}$/);
  });

  test("claude-sonnet-4-6 has both an input and an output rate", () => {
    const p = PRICE_TABLE["claude-sonnet-4-6"];
    assert.equal(typeof p.inputPerToken, "number");
    assert.ok(p.inputPerToken > 0);
    assert.equal(typeof p.outputPerToken, "number");
    assert.ok((p.outputPerToken ?? 0) > 0);
  });

  test("text-embedding-3-small has an input rate and no output rate (embeddings have no output tokens)", () => {
    const p = PRICE_TABLE["text-embedding-3-small"];
    assert.equal(typeof p.inputPerToken, "number");
    assert.ok(p.inputPerToken > 0);
    assert.equal(p.outputPerToken, undefined);
  });
});

describe("priceUsage() — known models", () => {
  test("claude-sonnet-4-6: basic arithmetic against the documented table", () => {
    const p = PRICE_TABLE["claude-sonnet-4-6"];
    const result = priceUsage("claude-sonnet-4-6", 1000, 500);
    const expected = 1000 * p.inputPerToken + 500 * (p.outputPerToken ?? 0);
    assert.equal(result.unpriced, false);
    assert.ok(Math.abs(result.costUsd - expected) < 1e-12);
  });

  test("claude-sonnet-4-6: 1,000,000 input + 1,000,000 output tokens costs input+output per-MTok rate", () => {
    const result = priceUsage("claude-sonnet-4-6", 1_000_000, 1_000_000);
    // $3/MTok in + $15/MTok out = $18 for 1M+1M tokens, per the pricing.ts source comment.
    assert.ok(Math.abs(result.costUsd - 18) < 1e-9);
  });

  test("text-embedding-3-small: input-only arithmetic (no output cost)", () => {
    const p = PRICE_TABLE["text-embedding-3-small"];
    const result = priceUsage("text-embedding-3-small", 800, 0);
    const expected = 800 * p.inputPerToken;
    assert.equal(result.unpriced, false);
    assert.ok(Math.abs(result.costUsd - expected) < 1e-12);
  });

  test("text-embedding-3-small: output tokens (if ever nonzero) are ignored, not priced", () => {
    const withOutput = priceUsage("text-embedding-3-small", 800, 500);
    const withoutOutput = priceUsage("text-embedding-3-small", 800, 0);
    assert.equal(withOutput.costUsd, withoutOutput.costUsd);
  });

  test("zero tokens costs zero", () => {
    const result = priceUsage("claude-sonnet-4-6", 0, 0);
    assert.equal(result.costUsd, 0);
    assert.equal(result.unpriced, false);
  });
});

describe("priceUsage() — prompt-caching tokens (lib/claude.ts's three cache_control call sites)", () => {
  test("a 3-argument call is unchanged from before caching was priced", () => {
    const result = priceUsage("claude-sonnet-4-6", 1000, 500);
    const p = PRICE_TABLE["claude-sonnet-4-6"];
    const expected = 1000 * p.inputPerToken + 500 * (p.outputPerToken ?? 0);
    assert.equal(result.unpriced, false);
    assert.ok(Math.abs(result.costUsd - expected) < 1e-12);
  });

  test("CACHE_WRITE_MULTIPLIER and CACHE_READ_MULTIPLIER are the documented 1.25x / 0.1x", () => {
    assert.equal(CACHE_WRITE_MULTIPLIER, 1.25);
    assert.equal(CACHE_READ_MULTIPLIER, 0.1);
  });

  test("cache-creation tokens are priced at CACHE_WRITE_MULTIPLIER times the model's input rate", () => {
    const p = PRICE_TABLE["claude-sonnet-4-6"];
    const withCache = priceUsage("claude-sonnet-4-6", 1000, 500, 400, 0);
    const withoutCache = priceUsage("claude-sonnet-4-6", 1000, 500, 0, 0);
    const expectedCacheCost = 400 * p.inputPerToken * CACHE_WRITE_MULTIPLIER;
    assert.ok(Math.abs(withCache.costUsd - withoutCache.costUsd - expectedCacheCost) < 1e-12);
  });

  test("cache-read tokens are priced at CACHE_READ_MULTIPLIER times the model's input rate", () => {
    const p = PRICE_TABLE["claude-sonnet-4-6"];
    const withCache = priceUsage("claude-sonnet-4-6", 1000, 500, 0, 300);
    const withoutCache = priceUsage("claude-sonnet-4-6", 1000, 500, 0, 0);
    const expectedCacheCost = 300 * p.inputPerToken * CACHE_READ_MULTIPLIER;
    assert.ok(Math.abs(withCache.costUsd - withoutCache.costUsd - expectedCacheCost) < 1e-12);
  });

  test("omitted cache args default to 0, matching an explicit 0,0 call", () => {
    const omitted = priceUsage("claude-sonnet-4-6", 1000, 500);
    const explicitZero = priceUsage("claude-sonnet-4-6", 1000, 500, 0, 0);
    assert.equal(omitted.costUsd, explicitZero.costUsd);
  });

  test("non-finite cache token counts (NaN) never produce a non-finite cost", () => {
    const result = priceUsage("claude-sonnet-4-6", 1000, 500, NaN, NaN);
    assert.equal(Number.isFinite(result.costUsd), true);
    const withoutCache = priceUsage("claude-sonnet-4-6", 1000, 500, 0, 0);
    assert.equal(result.costUsd, withoutCache.costUsd);
  });
});

describe("priceUsage() — unrecognized model degrades safely", () => {
  test("an unknown model id returns costUsd 0 and unpriced true, not a throw", () => {
    const original = console.warn;
    let warned = false;
    console.warn = () => {
      warned = true;
    };
    try {
      assert.doesNotThrow(() => {
        const result = priceUsage("some-future-model-nobody-priced-yet", 10_000, 5_000);
        assert.equal(result.costUsd, 0);
        assert.equal(result.unpriced, true);
      });
      assert.equal(warned, true, "an unpriced model should warn, not silently misprice");
    } finally {
      console.warn = original;
    }
  });

  test("an empty-string model id also degrades safely", () => {
    const original = console.warn;
    console.warn = () => {};
    try {
      const result = priceUsage("", 100, 100);
      assert.equal(result.costUsd, 0);
      assert.equal(result.unpriced, true);
    } finally {
      console.warn = original;
    }
  });

  test("non-finite token counts (NaN) never produce a non-finite cost", () => {
    const result = priceUsage("claude-sonnet-4-6", NaN, NaN);
    assert.equal(Number.isFinite(result.costUsd), true);
    assert.equal(result.costUsd, 0);
  });

  test("an unpriced model (e.g. a local model) warns at most once per model per process", () => {
    const original = console.warn;
    let warnCount = 0;
    console.warn = () => {
      warnCount += 1;
    };
    try {
      const localModel = "gemma4:latest-dedup-test";
      const first = priceUsage(localModel, 100, 50);
      const second = priceUsage(localModel, 200, 75);
      const third = priceUsage(localModel, 0, 0);
      assert.equal(first.costUsd, 0);
      assert.equal(first.unpriced, true);
      assert.equal(second.costUsd, 0);
      assert.equal(second.unpriced, true);
      assert.equal(third.costUsd, 0);
      assert.equal(third.unpriced, true);
      assert.equal(warnCount, 1, "repeated calls for the same unpriced model must warn only once");

      // A different unpriced model id still gets its own first warning.
      const anotherModel = "nomic-embed-text-dedup-test";
      priceUsage(anotherModel, 10, 0);
      assert.equal(warnCount, 2, "a distinct unpriced model gets its own first warning");
    } finally {
      console.warn = original;
    }
  });
});
