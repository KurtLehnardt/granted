import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCorpusStatus } from "../handler";
import { CorpusStore } from "@/lib/corpus/store";
import { acquireRefreshLock, isRefreshing, readRefreshStatus, releaseRefreshLock, writeRefreshStatus } from "@/lib/corpus/refreshStatus";

// Injected temp baseDir throughout — never the real cwd's data/local/ (that's
// shared with a real `npm run data:refresh` and other suites' locks/status).
function makeBaseDir() {
  const baseDir = mkdtempSync(join(tmpdir(), "granted-corpus-route-"));
  mkdirSync(join(baseDir, "data"), { recursive: true });
  writeFileSync(join(baseDir, "data", "opportunities.json"), JSON.stringify([{ id: "a" }]));
  writeFileSync(join(baseDir, "data", "corpus-meta.json"), JSON.stringify({}));
  return baseDir;
}

function depsFor(baseDir: string) {
  const store = new CorpusStore(baseDir);
  return {
    getCorpusInfo: () => store.load(),
    isRefreshing: () => isRefreshing(baseDir),
    readRefreshStatus: () => readRefreshStatus(baseDir),
  };
}

describe("GET /api/corpus", () => {
  test("reports the active corpus's shape", () => {
    const baseDir = makeBaseDir();
    const body = buildCorpusStatus(depsFor(baseDir));
    assert.equal(typeof body.count, "number");
    assert.ok(body.count > 0); // the committed corpus is never empty
    assert.equal(typeof body.stale, "boolean");
    assert.equal(body.refreshing, false);
    assert.equal(body.lastError, undefined);
    rmSync(baseDir, { recursive: true, force: true });
  });

  test("refreshing:true while the lock is held", () => {
    const baseDir = makeBaseDir();
    assert.equal(acquireRefreshLock(baseDir), true);
    const body = buildCorpusStatus(depsFor(baseDir));
    assert.equal(body.refreshing, true);
    releaseRefreshLock(baseDir);
    rmSync(baseDir, { recursive: true, force: true });
  });

  test("surfaces lastError + lastAttemptAt from the last failed run", () => {
    const baseDir = makeBaseDir();
    writeRefreshStatus({ lastError: "network unreachable", lastAttemptAt: "2026-09-27T00:00:00.000Z" }, baseDir);
    const body = buildCorpusStatus(depsFor(baseDir));
    assert.equal(body.lastError, "network unreachable");
    assert.equal(body.lastAttemptAt, "2026-09-27T00:00:00.000Z");
    rmSync(baseDir, { recursive: true, force: true });
  });
});
