import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { formatDuration } from "../SearchProgress";

/**
 * Unit test for the pure `formatDuration` helper behind the adaptive
 * "your last search took ~X" estimate. Imports only the named export (the React
 * component itself is never rendered), matching the node:test style used across
 * the repo.
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
