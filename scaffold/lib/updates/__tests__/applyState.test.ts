import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  readApplyState,
  tryAcquireApplyLock,
  setApplyPhase,
  markApplyDone,
  markApplyFailed,
  _resetApplyStateForTests,
} from "../applyState";

beforeEach(() => {
  _resetApplyStateForTests();
});

describe("applyState", () => {
  test("starts idle", () => {
    assert.deepEqual(readApplyState(), { phase: "idle" });
  });

  test("tryAcquireApplyLock succeeds from idle, transitioning to pulling with a startedAt timestamp", () => {
    assert.equal(tryAcquireApplyLock(), true);
    const state = readApplyState();
    assert.equal(state.phase, "pulling");
    assert.ok(state.startedAt);
    assert.ok(!Number.isNaN(Date.parse(state.startedAt as string)));
  });

  test("tryAcquireApplyLock fails while pulling (single-flight)", () => {
    tryAcquireApplyLock();
    assert.equal(tryAcquireApplyLock(), false);
    assert.equal(readApplyState().phase, "pulling");
  });

  test("tryAcquireApplyLock fails while installing (single-flight)", () => {
    tryAcquireApplyLock();
    setApplyPhase("installing");
    assert.equal(tryAcquireApplyLock(), false);
    assert.equal(readApplyState().phase, "installing");
  });

  test("tryAcquireApplyLock succeeds again once done", () => {
    tryAcquireApplyLock();
    markApplyDone();
    assert.equal(tryAcquireApplyLock(), true);
    assert.equal(readApplyState().phase, "pulling");
  });

  test("tryAcquireApplyLock succeeds again once failed", () => {
    tryAcquireApplyLock();
    markApplyFailed("boom");
    assert.equal(tryAcquireApplyLock(), true);
    assert.equal(readApplyState().phase, "pulling");
  });

  test("setApplyPhase('installing') moves phase to installing and preserves startedAt", () => {
    tryAcquireApplyLock();
    const { startedAt } = readApplyState();
    setApplyPhase("installing");
    const state = readApplyState();
    assert.equal(state.phase, "installing");
    assert.equal(state.startedAt, startedAt);
  });

  test("markApplyDone sets phase done with a completedAt, dropping startedAt/error", () => {
    tryAcquireApplyLock();
    markApplyDone();
    const state = readApplyState();
    assert.deepEqual(Object.keys(state).sort(), ["completedAt", "phase"]);
    assert.equal(state.phase, "done");
    assert.ok(state.completedAt);
    assert.ok(!Number.isNaN(Date.parse(state.completedAt as string)));
  });

  test("markApplyFailed sets phase failed with the given error and a completedAt", () => {
    tryAcquireApplyLock();
    markApplyFailed("pull failed: conflict");
    const state = readApplyState();
    assert.equal(state.phase, "failed");
    assert.equal(state.error, "pull failed: conflict");
    assert.ok(state.completedAt);
    assert.ok(!Number.isNaN(Date.parse(state.completedAt as string)));
  });

  test("_resetApplyStateForTests returns to a clean idle state", () => {
    tryAcquireApplyLock();
    markApplyFailed("whatever");
    _resetApplyStateForTests();
    assert.deepEqual(readApplyState(), { phase: "idle" });
  });
});
