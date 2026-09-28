import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireRefreshLock,
  releaseRefreshLock,
  isRefreshing,
  readRefreshStatus,
  writeRefreshStatus,
} from "../refreshStatus";

function makeBaseDir() {
  return mkdtempSync(join(tmpdir(), "granted-refresh-status-"));
}

describe("refresh lock", () => {
  test("acquire/release single-flight", () => {
    const baseDir = makeBaseDir();
    assert.equal(isRefreshing(baseDir), false);
    assert.equal(acquireRefreshLock(baseDir), true);
    assert.equal(isRefreshing(baseDir), true);
    assert.equal(acquireRefreshLock(baseDir), false); // already held
    releaseRefreshLock(baseDir);
    assert.equal(isRefreshing(baseDir), false);
    assert.equal(acquireRefreshLock(baseDir), true); // can re-acquire after release
    releaseRefreshLock(baseDir);
    rmSync(baseDir, { recursive: true, force: true });
  });

  test("a stale lock (crashed run) self-heals", () => {
    const baseDir = makeBaseDir();
    mkdirSync(join(baseDir, "data", "local"), { recursive: true });
    const staleTimestamp = Date.now() - 60 * 60 * 1000; // 1h old, past the 30m ceiling
    writeFileSync(join(baseDir, "data", "local", "refresh.lock"), String(staleTimestamp));
    assert.equal(isRefreshing(baseDir), false);
    assert.equal(acquireRefreshLock(baseDir), true);
    releaseRefreshLock(baseDir);
    rmSync(baseDir, { recursive: true, force: true });
  });

  test("releasing a lock that was never acquired is a no-op", () => {
    const baseDir = makeBaseDir();
    assert.doesNotThrow(() => releaseRefreshLock(baseDir));
    rmSync(baseDir, { recursive: true, force: true });
  });
});

describe("refresh status", () => {
  test("read defaults to {} when nothing was written", () => {
    const baseDir = makeBaseDir();
    assert.deepEqual(readRefreshStatus(baseDir), {});
    rmSync(baseDir, { recursive: true, force: true });
  });

  test("write then read round-trips, and a clean write clears a prior error", () => {
    const baseDir = makeBaseDir();
    writeRefreshStatus({ lastError: "boom" }, baseDir);
    assert.deepEqual(readRefreshStatus(baseDir), { lastError: "boom" });
    writeRefreshStatus({ lastCompletedAt: "2026-09-27T00:00:00.000Z" }, baseDir);
    assert.deepEqual(readRefreshStatus(baseDir), { lastCompletedAt: "2026-09-27T00:00:00.000Z" });
    rmSync(baseDir, { recursive: true, force: true });
  });
});
