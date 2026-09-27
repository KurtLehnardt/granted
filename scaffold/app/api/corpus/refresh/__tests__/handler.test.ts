import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { handleRefreshPost } from "../handler";

function fakeReq(): { headers: { get(name: string): string | null } } {
  return { headers: { get: () => null } }; // no proxy headers -> loopback
}

function fakeChild() {
  const child = new EventEmitter() as any;
  child.unref = () => {};
  return child;
}

describe("POST /api/corpus/refresh (handler)", () => {
  test("403 when the request is not loopback", async () => {
    let spawned = false;
    const res = await handleRefreshPost(fakeReq(), {
      isLoopbackRequest: () => false,
      isRefreshing: () => false,
      spawn: () => {
        spawned = true;
        return fakeChild();
      },
    });
    assert.equal(res.status, 403);
    assert.equal(spawned, false);
  });

  test("409 when a refresh is already running (single-flight)", async () => {
    let spawned = false;
    const res = await handleRefreshPost(fakeReq(), {
      isLoopbackRequest: () => true,
      isRefreshing: () => true,
      spawn: () => {
        spawned = true;
        return fakeChild();
      },
    });
    assert.equal(res.status, 409);
    assert.equal(spawned, false);
  });

  test("202 and spawns the refresh script when loopback and idle", async () => {
    let spawnedWith: [string, string[]] | null = null;
    const res = await handleRefreshPost(fakeReq(), {
      isLoopbackRequest: () => true,
      isRefreshing: () => false,
      spawn: (command: string, args: string[]) => {
        spawnedWith = [command, args];
        return fakeChild();
      },
    });
    assert.equal(res.status, 202);
    assert.deepEqual(await res.json(), { started: true });
    const call = spawnedWith as [string, string[]] | null;
    assert.ok(call);
    assert.ok(call[1].includes("scripts/refresh-corpus.mjs"));
  });
});
