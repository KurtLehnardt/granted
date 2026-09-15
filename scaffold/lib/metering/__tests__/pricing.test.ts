import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { priceUsage, PRICE_TABLE, PRICING_AS_OF } from "../pricing";

/**
 * R4b — pricing.ts: pure arithmetic against the documented PRICE_TABLE, plus
 * the "unrecognized model degrades safely" guarantee `meter.ts` relies on.
 */

describe("PRICE_TABLE — shape", () => {
  test("keyed by the exact two model ids in live use", () => {
    assert.ok(PRICE_TABLE["claude-sonnet-4-6"], "claude-sonnet-4-6 must be priced");
    assert.ok(PRICE_TABLE["text-embedding-3-small"], "text-embedding-3-small must be priced");
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
