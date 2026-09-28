import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { shouldAutoRefresh, RETRY_BACKOFF_MS } from "../autoUpdate";

describe("shouldAutoRefresh", () => {
  test("skips when not stale", () => {
    assert.equal(shouldAutoRefresh({ stale: false, refreshing: false }), false);
  });

  test("skips when already refreshing", () => {
    assert.equal(shouldAutoRefresh({ stale: true, refreshing: true }), false);
  });

  test("refreshes when stale with no prior attempt", () => {
    assert.equal(shouldAutoRefresh({ stale: true, refreshing: false }), true);
  });

  test("backs off within 12h of a recorded attempt, even without lastError", () => {
    const now = Date.parse("2026-09-27T12:00:00.000Z");
    const lastAttemptAt = "2026-09-27T06:00:00.000Z"; // 6h ago — a killed/OOM'd child never wrote lastError
    assert.equal(shouldAutoRefresh({ stale: true, refreshing: false, lastAttemptAt }, now), false);
  });

  test("resumes retrying once the backoff window has elapsed", () => {
    const now = Date.parse("2026-09-27T12:00:00.000Z");
    const lastAttemptAt = new Date(now - RETRY_BACKOFF_MS - 1000).toISOString();
    assert.equal(shouldAutoRefresh({ stale: true, refreshing: false, lastAttemptAt }, now), true);
  });

  test("ignores an unparseable lastAttemptAt", () => {
    assert.equal(shouldAutoRefresh({ stale: true, refreshing: false, lastAttemptAt: "garbage" }), true);
  });
});
