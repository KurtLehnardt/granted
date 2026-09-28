import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { handleRefreshPost } from "../handler";

function fakeReq(body?: unknown): { headers: { get(name: string): string | null }; json: () => Promise<unknown> } {
  return {
    headers: { get: () => null }, // no proxy headers -> loopback
    json: async () => {
      if (body === undefined) throw new Error("no body");
      return body;
    },
  };
}

function fakeChild() {
  const child = new EventEmitter() as any;
  child.pid = 4321;
  child.unref = () => {};
  return child;
}

describe("POST /api/corpus/refresh (handler)", () => {
  test("403 when the request is not loopback", async () => {
    let spawned = false;
    const res = await handleRefreshPost(fakeReq(), {
      isLoopbackRequest: () => false,
      acquireRefreshLock: () => true,
      releaseRefreshLock: () => {},
      transferRefreshLock: () => {},
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
      acquireRefreshLock: () => false,
      releaseRefreshLock: () => {},
      transferRefreshLock: () => {},
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
    let transferredPid: number | null = null;
    const res = await handleRefreshPost(fakeReq(), {
      isLoopbackRequest: () => true,
      acquireRefreshLock: () => true,
      releaseRefreshLock: () => {},
      transferRefreshLock: (pid) => {
        transferredPid = pid;
      },
      writeRefreshStatus: () => {},
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
    assert.equal(transferredPid, 4321); // hands the lock to the child's real pid
  });

  test("releases the lock and rethrows when spawn itself throws", async () => {
    let released = false;
    await assert.rejects(
      handleRefreshPost(fakeReq(), {
        isLoopbackRequest: () => true,
        acquireRefreshLock: () => true,
        releaseRefreshLock: () => {
          released = true;
        },
        transferRefreshLock: () => {},
        writeRefreshStatus: () => {},
        spawn: () => {
          throw new Error("ENOENT");
        },
      }),
    );
    assert.equal(released, true);
  });

  test("releases the lock and rethrows when writeRefreshStatus throws", async () => {
    let released = false;
    let spawned = false;
    await assert.rejects(
      handleRefreshPost(fakeReq(), {
        isLoopbackRequest: () => true,
        acquireRefreshLock: () => true,
        releaseRefreshLock: () => {
          released = true;
        },
        transferRefreshLock: () => {},
        writeRefreshStatus: () => {
          throw new Error("disk full");
        },
        spawn: () => {
          spawned = true;
          return fakeChild();
        },
      }),
    );
    assert.equal(released, true);
    assert.equal(spawned, false);
  });

  test("clamps a client-supplied max into --max <n>", async () => {
    let spawnedWith: string[] | null = null;
    await handleRefreshPost(fakeReq({ max: 99999999 }), {
      isLoopbackRequest: () => true,
      acquireRefreshLock: () => true,
      releaseRefreshLock: () => {},
      transferRefreshLock: () => {},
      writeRefreshStatus: () => {},
      spawn: (_command: string, args: string[]) => {
        spawnedWith = args;
        return fakeChild();
      },
    });
    const args = spawnedWith as string[] | null;
    assert.ok(args);
    assert.deepEqual(args.slice(-2), ["--max", "20000"]);
  });

  test("no body / invalid max omits --max, letting the script use its own default", async () => {
    let spawnedWith: string[] | null = null;
    await handleRefreshPost(fakeReq(), {
      isLoopbackRequest: () => true,
      acquireRefreshLock: () => true,
      releaseRefreshLock: () => {},
      transferRefreshLock: () => {},
      writeRefreshStatus: () => {},
      spawn: (_command: string, args: string[]) => {
        spawnedWith = args;
        return fakeChild();
      },
    });
    assert.ok(!(spawnedWith as string[] | null)?.includes("--max"));
  });

  test("records lastAttemptAt synchronously when the refresh starts, before the child can fail", async () => {
    let recordedStatus: unknown = null;
    await handleRefreshPost(fakeReq(), {
      isLoopbackRequest: () => true,
      acquireRefreshLock: () => true,
      releaseRefreshLock: () => {},
      transferRefreshLock: () => {},
      writeRefreshStatus: (status) => {
        recordedStatus = status;
      },
      spawn: () => fakeChild(),
    });
    const status = recordedStatus as { lastAttemptAt?: string } | null;
    assert.ok(status?.lastAttemptAt);
    assert.ok(!Number.isNaN(Date.parse(status.lastAttemptAt as string)));
  });

  test("a spawn 'error' event (async failure) releases the lock and records lastError", async () => {
    let released = false;
    let recordedStatus: unknown = null;
    const child = fakeChild();
    await handleRefreshPost(fakeReq(), {
      isLoopbackRequest: () => true,
      acquireRefreshLock: () => true,
      releaseRefreshLock: () => {
        released = true;
      },
      transferRefreshLock: () => {},
      writeRefreshStatus: (status) => {
        recordedStatus = status;
      },
      spawn: () => child,
    });
    child.emit("error", new Error("spawn ENOENT"));
    assert.equal(released, true);
    assert.equal((recordedStatus as { lastError?: string })?.lastError, "spawn ENOENT");
  });
});
