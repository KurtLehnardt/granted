import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { handleUpdatesApplyPost } from "../handler";

function fakeReq(): { headers: { get(name: string): string | null } } {
  return { headers: { get: () => null } }; // unused — isLoopbackRequest is mocked per-test below
}

describe("POST /api/updates/apply (handler)", () => {
  test("403 when the request is not loopback", async () => {
    let acquired = false;
    let ran = false;
    const res = await handleUpdatesApplyPost(fakeReq(), {
      isLoopbackRequest: () => false,
      tryAcquireApplyLock: () => {
        acquired = true;
        return true;
      },
      runApplyInBackground: async () => {
        ran = true;
      },
    });
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), { error: "Update check is only available from localhost" });
    assert.equal(acquired, false);
    assert.equal(ran, false);
  });

  test("409 + runApplyInBackground never invoked when the lock can't be acquired (single-flight)", async () => {
    let ran = false;
    const res = await handleUpdatesApplyPost(fakeReq(), {
      isLoopbackRequest: () => true,
      tryAcquireApplyLock: () => false,
      runApplyInBackground: async () => {
        ran = true;
      },
    });
    assert.equal(res.status, 409);
    assert.deepEqual(await res.json(), { error: "Update already in progress" });
    assert.equal(ran, false);
  });

  test("202 + {started:true} when the lock is acquired", async () => {
    const res = await handleUpdatesApplyPost(fakeReq(), {
      isLoopbackRequest: () => true,
      tryAcquireApplyLock: () => true,
      runApplyInBackground: async () => {},
    });
    assert.equal(res.status, 202);
    assert.deepEqual(await res.json(), { started: true });
  });

  test("fire-and-forget: the handler's own promise settles even though runApplyInBackground's never does", async () => {
    let runApplyInvoked = false;
    const neverResolves = new Promise<void>(() => {
      // deliberately never settles — proves the handler doesn't await this
    });
    const res = await handleUpdatesApplyPost(fakeReq(), {
      isLoopbackRequest: () => true,
      tryAcquireApplyLock: () => true,
      runApplyInBackground: () => {
        runApplyInvoked = true;
        return neverResolves;
      },
    });
    assert.equal(runApplyInvoked, true);
    assert.equal(res.status, 202);
    assert.deepEqual(await res.json(), { started: true });
  });
});
