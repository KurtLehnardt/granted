import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createCostMeter } from "../meter";
import { PRICE_TABLE, PRICING_AS_OF, CACHE_WRITE_MULTIPLIER, CACHE_READ_MULTIPLIER } from "../pricing";

/**
 * R4b — meter.ts: aggregation correctness, and the "never breaks a search"
 * defensiveness guarantee that `lib/claude.ts`, `lib/embed.ts`, and
 * `lib/match.ts` all rely on without their own extra guards (beyond the
 * belt-and-suspenders wrap already in `lib/match.ts` itself).
 */

describe("CostMeter — summary() with nothing recorded", () => {
  test("returns a well-formed empty result, not a throw", () => {
    const meter = createCostMeter();
    assert.doesNotThrow(() => {
      const summary = meter.summary();
      assert.deepEqual(summary.stages, []);
      assert.equal(summary.totalCostUsd, 0);
      assert.equal(typeof summary.totalLatencyMs, "number");
      assert.ok(summary.totalLatencyMs >= 0);
      assert.equal(summary.pricingAsOf, PRICING_AS_OF);
    });
  });

  test("logSummary() with nothing recorded does not throw", () => {
    const meter = createCostMeter();
    const original = console.log;
    let logged: unknown[] | undefined;
    console.log = (...args: unknown[]) => {
      logged = args;
    };
    try {
      assert.doesNotThrow(() => meter.logSummary());
      assert.ok(logged, "logSummary should still emit a line for an empty search");
    } finally {
      console.log = original;
    }
  });
});

describe("CostMeter — record() single-call stages aggregate correctly", () => {
  test("one profile_extraction call prices and stores tokens/latency as given", () => {
    const meter = createCostMeter();
    meter.record({
      stage: "profile_extraction",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      inputTokens: 500,
      outputTokens: 200,
      latencyMs: 850,
    });
    const summary = meter.summary();
    assert.equal(summary.stages.length, 1);
    const stage = summary.stages[0];
    assert.equal(stage.stage, "profile_extraction");
    assert.equal(stage.provider, "anthropic");
    assert.equal(stage.model, "claude-sonnet-4-6");
    assert.equal(stage.inputTokens, 500);
    assert.equal(stage.outputTokens, 200);
    assert.equal(stage.latencyMs, 850);
    assert.equal(stage.calls, 1);
    const p = PRICE_TABLE["claude-sonnet-4-6"];
    const expectedCost = 500 * p.inputPerToken + 200 * (p.outputPerToken ?? 0);
    assert.ok(Math.abs(stage.costUsd - expectedCost) < 1e-12);
    assert.ok(Math.abs(summary.totalCostUsd - expectedCost) < 1e-12);
  });

  test("query_embedding (OpenAI) records input tokens only, zero output cost", () => {
    const meter = createCostMeter();
    meter.record({
      stage: "query_embedding",
      provider: "openai",
      model: "text-embedding-3-small",
      inputTokens: 120,
      outputTokens: 0,
      latencyMs: 220,
    });
    const stage = meter.summary().stages[0];
    assert.equal(stage.provider, "openai");
    assert.equal(stage.outputTokens, 0);
    const p = PRICE_TABLE["text-embedding-3-small"];
    assert.ok(Math.abs(stage.costUsd - 120 * p.inputPerToken) < 1e-12);
  });

  test("multiple distinct stages stay in separate entries", () => {
    const meter = createCostMeter();
    meter.record({
      stage: "profile_extraction",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      inputTokens: 100,
      outputTokens: 50,
      latencyMs: 300,
    });
    meter.record({
      stage: "weak_field_explanation",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      inputTokens: 80,
      outputTokens: 120,
      latencyMs: 400,
    });
    const summary = meter.summary();
    assert.equal(summary.stages.length, 2);
    const names = summary.stages.map((s) => s.stage).sort();
    assert.deepEqual(names, ["profile_extraction", "weak_field_explanation"]);
  });
});

describe("CostMeter — record() multi-call stage aggregation (candidate_analysis-style)", () => {
  test("several concurrent batches under one stage sum tokens, cost, and call count", () => {
    const meter = createCostMeter();
    // Simulate explainMatches's Promise.allSettled fan-out: three batches,
    // each recorded as its own call resolves (mirrors scoreGroup's per-batch
    // record() call, not a post-allSettled aggregate).
    meter.record({
      stage: "candidate_analysis",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      inputTokens: 1000,
      outputTokens: 700,
      latencyMs: 4000,
    });
    meter.record({
      stage: "candidate_analysis",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      inputTokens: 1100,
      outputTokens: 650,
      latencyMs: 4200,
    });
    meter.record({
      stage: "candidate_analysis",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      inputTokens: 950,
      outputTokens: 720,
      latencyMs: 3900,
    });

    const beforeOverride = meter.summary().stages[0];
    assert.equal(beforeOverride.calls, 3);
    assert.equal(beforeOverride.inputTokens, 1000 + 1100 + 950);
    assert.equal(beforeOverride.outputTokens, 700 + 650 + 720);
    // Before the stage-latency override, record() sums the individual calls'
    // latencies (this is the "wrong for concurrent work" value the design
    // explicitly says recordStageLatency() must overwrite).
    assert.equal(beforeOverride.latencyMs, 4000 + 4200 + 3900);

    // The real fan-out wall-clock (measured by whoever awaited
    // Promise.allSettled) replaces the summed value — concurrent calls must
    // not have their latencies added together.
    meter.recordStageLatency("candidate_analysis", 4300);
    const after = meter.summary().stages[0];
    assert.equal(after.latencyMs, 4300);
    // Tokens/cost/calls are untouched by the latency override.
    assert.equal(after.calls, 3);
    assert.equal(after.inputTokens, 1000 + 1100 + 950);
  });

  test("recordStageLatency() on a stage with nothing recorded yet is a silent no-op", () => {
    const meter = createCostMeter();
    assert.doesNotThrow(() => meter.recordStageLatency("candidate_analysis", 9999));
    assert.equal(meter.summary().stages.length, 0);
  });

  test("a batch that fails after its API call still has its usage captured (fault tolerance)", () => {
    // Mirrors explainMatches: record() is called the instant each batch's
    // API call resolves, before parseJson() — so a batch whose JSON parsing
    // later throws (simulated here by simply never calling anything after
    // record()) still contributes its spend.
    const meter = createCostMeter();
    meter.record({
      stage: "candidate_analysis",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      inputTokens: 500,
      outputTokens: 300,
      latencyMs: 1000,
    }); // this "batch" then hypothetically throws in parseJson — record() already ran.
    const stage = meter.summary().stages[0];
    assert.equal(stage.calls, 1);
    assert.ok(stage.costUsd > 0);
  });
});

describe("CostMeter — cache token fields (prompt caching is in active use)", () => {
  test("cache fields are summed AND folded into costUsd at the documented multipliers", () => {
    const meter = createCostMeter();
    meter.record({
      stage: "profile_extraction",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      inputTokens: 100,
      outputTokens: 50,
      cacheCreationInputTokens: 40,
      cacheReadInputTokens: 10,
      latencyMs: 200,
    });
    const stage = meter.summary().stages[0];
    assert.equal(stage.cacheCreationInputTokens, 40);
    assert.equal(stage.cacheReadInputTokens, 10);
    const p = PRICE_TABLE["claude-sonnet-4-6"];
    const expectedCost =
      100 * p.inputPerToken +
      50 * (p.outputPerToken ?? 0) +
      40 * p.inputPerToken * CACHE_WRITE_MULTIPLIER +
      10 * p.inputPerToken * CACHE_READ_MULTIPLIER;
    assert.ok(Math.abs(stage.costUsd - expectedCost) < 1e-12, "cache tokens must be priced into costUsd");
  });

  test("cache fields stay undefined when absent (today's real-world case)", () => {
    const meter = createCostMeter();
    meter.record({
      stage: "profile_extraction",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      inputTokens: 100,
      outputTokens: 50,
      latencyMs: 200,
    });
    const stage = meter.summary().stages[0];
    assert.equal(stage.cacheCreationInputTokens, undefined);
    assert.equal(stage.cacheReadInputTokens, undefined);
  });
});

describe("CostMeter — record() never throws on malformed input", () => {
  test("undefined usage numbers do not throw and do not corrupt the running total", () => {
    const meter = createCostMeter();
    assert.doesNotThrow(() => {
      meter.record({
        stage: "profile_extraction",
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        inputTokens: undefined as unknown as number,
        outputTokens: undefined as unknown as number,
        latencyMs: undefined as unknown as number,
      });
    });
    const stage = meter.summary().stages[0];
    assert.equal(stage.inputTokens, 0);
    assert.equal(stage.outputTokens, 0);
    assert.equal(stage.latencyMs, 0);
    assert.equal(stage.costUsd, 0);
    assert.equal(stage.calls, 1);
  });

  test("NaN usage numbers degrade to 0, not NaN, and don't poison later valid records", () => {
    const meter = createCostMeter();
    meter.record({
      stage: "profile_extraction",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      inputTokens: NaN,
      outputTokens: NaN,
      latencyMs: NaN,
    });
    meter.record({
      stage: "profile_extraction",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      inputTokens: 100,
      outputTokens: 50,
      latencyMs: 300,
    });
    const stage = meter.summary().stages[0];
    assert.equal(Number.isNaN(stage.inputTokens), false);
    assert.equal(stage.inputTokens, 100);
    assert.equal(stage.calls, 2);
  });

  test("completely garbage input object does not throw", () => {
    const meter = createCostMeter();
    assert.doesNotThrow(() => meter.record({} as unknown as Parameters<typeof meter.record>[0]));
    assert.doesNotThrow(() => meter.record(null as unknown as Parameters<typeof meter.record>[0]));
    assert.doesNotThrow(() => meter.record(undefined as unknown as Parameters<typeof meter.record>[0]));
    assert.doesNotThrow(() => meter.record("garbage" as unknown as Parameters<typeof meter.record>[0]));
  });

  test("an unrecognized model id inside record() still aggregates tokens, at zero cost, without throwing", () => {
    const meter = createCostMeter();
    const original = console.warn;
    console.warn = () => {};
    try {
      assert.doesNotThrow(() => {
        meter.record({
          stage: "candidate_analysis",
          provider: "anthropic",
          model: "some-unpriced-future-model",
          inputTokens: 1000,
          outputTokens: 500,
          latencyMs: 1000,
        });
      });
    } finally {
      console.warn = original;
    }
    const stage = meter.summary().stages[0];
    assert.equal(stage.inputTokens, 1000);
    assert.equal(stage.costUsd, 0);
  });

  test("a garbage stage name falls back to a safe default instead of throwing", () => {
    const meter = createCostMeter();
    assert.doesNotThrow(() => {
      meter.record({
        stage: "" as unknown as string,
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        inputTokens: 10,
        outputTokens: 10,
        latencyMs: 10,
      });
    });
    assert.equal(meter.summary().stages.length, 1);
  });
});

describe("CostMeter — logSummary()", () => {
  test("emits a JSON-serializable [cost] line reflecting the recorded stages", () => {
    const meter = createCostMeter();
    meter.record({
      stage: "profile_extraction",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      inputTokens: 300,
      outputTokens: 150,
      latencyMs: 500,
    });
    const original = console.log;
    let capturedArgs: unknown[] = [];
    console.log = (...args: unknown[]) => {
      capturedArgs = args;
    };
    try {
      meter.logSummary();
    } finally {
      console.log = original;
    }
    assert.equal(capturedArgs[0], "[cost]");
    const parsed = JSON.parse(capturedArgs[1] as string);
    assert.equal(parsed.stages.length, 1);
    assert.equal(parsed.stages[0].stage, "profile_extraction");
    assert.equal(parsed.pricingAsOf, PRICING_AS_OF);
  });

  test("accepts a precomputed summary and logs that exact object instead of recomputing", () => {
    const meter = createCostMeter();
    meter.record({
      stage: "profile_extraction",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      inputTokens: 300,
      outputTokens: 150,
      latencyMs: 500,
    });
    const precomputed = meter.summary();
    const original = console.log;
    let capturedArgs: unknown[] = [];
    console.log = (...args: unknown[]) => {
      capturedArgs = args;
    };
    try {
      meter.logSummary(precomputed);
    } finally {
      console.log = original;
    }
    const parsed = JSON.parse(capturedArgs[1] as string);
    assert.deepEqual(parsed, precomputed);
  });

  test("a throwing console.log does not propagate out of logSummary()", () => {
    const meter = createCostMeter();
    const original = console.log;
    console.log = () => {
      throw new Error("log sink exploded");
    };
    try {
      assert.doesNotThrow(() => meter.logSummary());
    } finally {
      console.log = original;
    }
  });
});
