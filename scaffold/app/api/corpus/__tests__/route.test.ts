import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { GET } from "../route";
import { acquireRefreshLock, releaseRefreshLock, writeRefreshStatus } from "@/lib/corpus/refreshStatus";

const LOCK = join(process.cwd(), "data", "local", "refresh.lock");
const STATUS = join(process.cwd(), "data", "local", "refresh-status.json");

function cleanup() {
  releaseRefreshLock();
  try {
    rmSync(STATUS, { force: true });
  } catch {
    /* ignore */
  }
}

describe("GET /api/corpus", () => {
  after(cleanup);

  test("reports the active corpus's shape", async () => {
    cleanup();
    const res = await GET();
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(typeof body.count, "number");
    assert.ok(body.count > 0); // the committed corpus is never empty
    assert.equal(typeof body.stale, "boolean");
    assert.equal(body.refreshing, false);
    assert.equal(body.lastError, undefined);
  });

  test("refreshing:true while the lock is held", async () => {
    cleanup();
    assert.equal(acquireRefreshLock(), true);
    const res = await GET();
    const body = await res.json();
    assert.equal(body.refreshing, true);
    cleanup();
  });

  test("surfaces lastError from the last failed run", async () => {
    cleanup();
    writeRefreshStatus({ lastError: "network unreachable" });
    const res = await GET();
    const body = await res.json();
    assert.equal(body.lastError, "network unreachable");
    cleanup();
  });
});
