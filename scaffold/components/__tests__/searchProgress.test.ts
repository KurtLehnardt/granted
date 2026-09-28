import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  formatDuration,
  formatSearchDuration,
  localModelEstimateRange,
  localModelLabel,
  localTwoPhaseMessage,
  estimateRemainingMs,
  parseScoreDetail,
} from "../SearchProgress";

/**
 * Unit tests for the pure helpers behind SearchProgress's status line. Import
 * only the named exports (the React component itself is never rendered),
 * matching the node:test style used across the repo.
 */
describe("SearchProgress formatDuration", () => {
  test("sub-minute durations read in seconds", () => {
    assert.equal(formatDuration(20_000), "about 20 seconds");
    assert.equal(formatDuration(45_000), "about 45 seconds");
  });

  test("~1 minute reads as 'about a minute'", () => {
    assert.equal(formatDuration(60_000), "about a minute");
    assert.equal(formatDuration(75_000), "about a minute"); // 1.25m rounds to 1
  });

  test("multiple minutes round to whole minutes", () => {
    assert.equal(formatDuration(90_000), "about 2 minutes"); // 1.5m rounds up
    assert.equal(formatDuration(480_000), "about 8 minutes");
  });

  test("clamps to at least 1 second (never 0 or negative)", () => {
    assert.equal(formatDuration(0), "about 1 seconds");
    assert.equal(formatDuration(-5), "about 1 seconds");
  });
});

describe("formatSearchDuration", () => {
  test("under a minute shows only seconds", () => {
    assert.equal(formatSearchDuration(0), "0s");
    assert.equal(formatSearchDuration(45_000), "45s");
  });

  test("minutes and seconds both shown", () => {
    assert.equal(formatSearchDuration(453_000), "7m 33s"); // 7:33
    assert.equal(formatSearchDuration(60_000), "1m 0s");
  });

  test("never negative even for a negative input", () => {
    assert.equal(formatSearchDuration(-100), "0s");
  });
});

describe("localModelEstimateRange", () => {
  test("small models get the tightest range", () => {
    assert.equal(localModelEstimateRange(3), "3–6 minutes");
    assert.equal(localModelEstimateRange(4), "3–6 minutes");
  });

  test("mid-size ranges by boundary", () => {
    assert.equal(localModelEstimateRange(7), "4–10 minutes");
    assert.equal(localModelEstimateRange(9), "4–10 minutes");
    assert.equal(localModelEstimateRange(13), "5–15 minutes");
    assert.equal(localModelEstimateRange(16), "5–15 minutes");
  });

  test("larger than the table -> a wider hedged range", () => {
    assert.equal(localModelEstimateRange(27), "10–30 minutes");
  });

  test("unknown size (undefined/NaN) -> the hedged unknown range", () => {
    assert.equal(localModelEstimateRange(undefined), "a few minutes or more");
    assert.equal(localModelEstimateRange(NaN), "a few minutes or more");
  });
});

describe("localTwoPhaseMessage", () => {
  test("names the model, its size, and both phases' timing", () => {
    const msg = localTwoPhaseMessage("qwen2.5:3b", 3.1);
    assert.match(msg, /^First matches appear in a few seconds\./);
    assert.match(msg, /qwen2\.5:3b \(3\.1B\)/);
    assert.match(msg, /3–6 minutes/);
    assert.match(msg, /explore the first results while the rest are analyzed/);
  });

  test("falls back to the hedged unknown range with no param count", () => {
    const msg = localTwoPhaseMessage("some-model", undefined);
    assert.match(msg, /a few minutes or more/);
  });
});

describe("localModelLabel", () => {
  test("model + size", () => {
    assert.equal(localModelLabel("gemma3:12b", 12), "gemma3:12b (12B)");
  });
  test("model, size unknown", () => {
    assert.equal(localModelLabel("gemma3:12b", undefined), "gemma3:12b");
  });
  test("no model name at all", () => {
    assert.equal(localModelLabel(undefined, undefined), "a local model");
  });
});

describe("estimateRemainingMs", () => {
  test("extrapolates linearly from the observed rate", () => {
    // 10 of 40 done in 60s -> 6s/item -> 30 left -> 180s = 180_000ms
    assert.equal(estimateRemainingMs(10, 40, 60_000), 180_000);
  });

  test("nothing scored yet -> no estimate", () => {
    assert.equal(estimateRemainingMs(0, 40, 60_000), null);
  });

  test("already done (or past total) -> no estimate", () => {
    assert.equal(estimateRemainingMs(40, 40, 60_000), null);
    assert.equal(estimateRemainingMs(41, 40, 60_000), null);
  });

  test("one-candidate-per-call: each reading extrapolates from time since the score step", () => {
    // 3 of 32 scored, 90s since "score" -> 30s/call -> 29 left -> 870s
    assert.equal(estimateRemainingMs(3, 32, 90_000), 870_000);
  });

  test("no elapsed time or no total -> no estimate", () => {
    assert.equal(estimateRemainingMs(5, 40, 0), null);
    assert.equal(estimateRemainingMs(5, 0, 60_000), null);
  });
});

describe("parseScoreDetail", () => {
  test("parses 'done/total'", () => {
    assert.deepEqual(parseScoreDetail("7/40"), { done: 7, total: 40 });
  });
  test("null for missing or malformed detail", () => {
    assert.equal(parseScoreDetail(undefined), null);
    assert.equal(parseScoreDetail(""), null);
    assert.equal(parseScoreDetail("not-a-fraction"), null);
  });
});
