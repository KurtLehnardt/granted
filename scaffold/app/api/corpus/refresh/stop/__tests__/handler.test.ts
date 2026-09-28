import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { handleRefreshStopPost } from "../handler";

function fakeReq(): { headers: { get(name: string): string | null } } {
  return { headers: { get: () => null } }; // no proxy headers -> loopback
}

describe("POST /api/corpus/refresh/stop (handler)", () => {
  test("403 when the request is not loopback", async () => {
    let requested = false;
    const res = await handleRefreshStopPost(fakeReq(), {
      isLoopbackRequest: () => false,
      isRefreshing: () => true,
      requestStop: () => {
        requested = true;
      },
    });
    assert.equal(res.status, 403);
    assert.equal(requested, false);
  });

  test("404 when nothing is running", async () => {
    let requested = false;
    const res = await handleRefreshStopPost(fakeReq(), {
      isLoopbackRequest: () => true,
      isRefreshing: () => false,
      requestStop: () => {
        requested = true;
      },
    });
    assert.equal(res.status, 404);
    assert.equal(requested, false);
  });

  test("writes the stop request and returns 200 when a refresh is running", async () => {
    let requested = false;
    const res = await handleRefreshStopPost(fakeReq(), {
      isLoopbackRequest: () => true,
      isRefreshing: () => true,
      requestStop: () => {
        requested = true;
      },
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { stopping: true });
    assert.equal(requested, true);
  });
});
