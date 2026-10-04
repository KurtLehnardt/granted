import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { handleUpdatesGet } from "../handler";

function fakeReq(): { headers: { get(name: string): string | null } } {
  return { headers: { get: () => null } }; // unused — isLoopbackRequest is mocked per-test below
}

const LOCAL_SHA = "a".repeat(40);
const REMOTE_SHA = "b".repeat(40);

describe("GET /api/updates (handler)", () => {
  test("403 when the request is not loopback", async () => {
    let localCalled = false;
    let remoteCalled = false;
    const res = await handleUpdatesGet(fakeReq(), {
      isLoopbackRequest: () => false,
      getLocalCommit: async () => {
        localCalled = true;
        return { sha: LOCAL_SHA };
      },
      fetchRemoteCommit: async () => {
        remoteCalled = true;
        return { sha: LOCAL_SHA };
      },
      readApplyState: () => ({ phase: "idle" }),
    });
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), { error: "Update check is only available from localhost" });
    assert.equal(localCalled, false);
    assert.equal(remoteCalled, false);
  });

  test('"unknown" when getLocalCommit reports notAGitCheckout — never calls GitHub', async () => {
    let remoteCalled = false;
    const res = await handleUpdatesGet(fakeReq(), {
      isLoopbackRequest: () => true,
      readApplyState: () => ({ phase: "idle" }),
      getLocalCommit: async () => ({ notAGitCheckout: true }),
      fetchRemoteCommit: async () => {
        remoteCalled = true;
        return { sha: REMOTE_SHA };
      },
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { state: "unknown" });
    assert.equal(remoteCalled, false);
  });

  test('"up-to-date" when local and remote SHAs match', async () => {
    const res = await handleUpdatesGet(fakeReq(), {
      isLoopbackRequest: () => true,
      readApplyState: () => ({ phase: "idle" }),
      getLocalCommit: async () => ({ sha: LOCAL_SHA }),
      fetchRemoteCommit: async () => ({ sha: LOCAL_SHA }),
    });
    assert.deepEqual(await res.json(), { state: "up-to-date", sha: LOCAL_SHA });
  });

  test('"update-available" with both SHAs when they differ', async () => {
    const res = await handleUpdatesGet(fakeReq(), {
      isLoopbackRequest: () => true,
      readApplyState: () => ({ phase: "idle" }),
      getLocalCommit: async () => ({ sha: LOCAL_SHA }),
      fetchRemoteCommit: async () => ({ sha: REMOTE_SHA }),
    });
    assert.deepEqual(await res.json(), { state: "update-available", localSha: LOCAL_SHA, remoteSha: REMOTE_SHA });
  });

  test('"error" (never throws) when the GitHub fetch fails, including localSha', async () => {
    const res = await handleUpdatesGet(fakeReq(), {
      isLoopbackRequest: () => true,
      readApplyState: () => ({ phase: "idle" }),
      getLocalCommit: async () => ({ sha: LOCAL_SHA }),
      fetchRemoteCommit: async () => ({ error: "GitHub returned 503" }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { state: "error", message: "GitHub returned 503", localSha: LOCAL_SHA });
  });

  test('"applying" (phase: pulling) short-circuits — getLocalCommit/fetchRemoteCommit called zero times', async () => {
    let localCalls = 0;
    let remoteCalls = 0;
    const res = await handleUpdatesGet(fakeReq(), {
      isLoopbackRequest: () => true,
      readApplyState: () => ({ phase: "pulling", startedAt: "2026-01-01T00:00:00.000Z" }),
      getLocalCommit: async () => {
        localCalls++;
        return { notAGitCheckout: true };
      },
      fetchRemoteCommit: async () => {
        remoteCalls++;
        return { error: "x" };
      },
    });
    assert.deepEqual(await res.json(), { state: "applying", phase: "pulling" });
    assert.equal(localCalls, 0);
    assert.equal(remoteCalls, 0);
  });

  test('"applying" (phase: installing) short-circuits the same way', async () => {
    let calls = 0;
    const res = await handleUpdatesGet(fakeReq(), {
      isLoopbackRequest: () => true,
      readApplyState: () => ({ phase: "installing" }),
      getLocalCommit: async () => {
        calls++;
        return { notAGitCheckout: true };
      },
      fetchRemoteCommit: async () => {
        calls++;
        return { error: "x" };
      },
    });
    assert.deepEqual(await res.json(), { state: "applying", phase: "installing" });
    assert.equal(calls, 0);
  });

  test('"applied" short-circuits — never calls git/GitHub', async () => {
    let calls = 0;
    const res = await handleUpdatesGet(fakeReq(), {
      isLoopbackRequest: () => true,
      readApplyState: () => ({ phase: "done", completedAt: "2026-01-01T00:00:00.000Z" }),
      getLocalCommit: async () => {
        calls++;
        return { notAGitCheckout: true };
      },
      fetchRemoteCommit: async () => {
        calls++;
        return { error: "x" };
      },
    });
    assert.deepEqual(await res.json(), { state: "applied" });
    assert.equal(calls, 0);
  });

  test('"apply-failed" short-circuits with the stored error message — never calls git/GitHub', async () => {
    let calls = 0;
    const res = await handleUpdatesGet(fakeReq(), {
      isLoopbackRequest: () => true,
      readApplyState: () => ({ phase: "failed", error: "git pull exited with code 1" }),
      getLocalCommit: async () => {
        calls++;
        return { notAGitCheckout: true };
      },
      fetchRemoteCommit: async () => {
        calls++;
        return { error: "x" };
      },
    });
    assert.deepEqual(await res.json(), { state: "apply-failed", message: "git pull exited with code 1" });
    assert.equal(calls, 0);
  });

  test('"apply-failed" with no stored error falls back to a generic message', async () => {
    const res = await handleUpdatesGet(fakeReq(), {
      isLoopbackRequest: () => true,
      readApplyState: () => ({ phase: "failed" }),
      getLocalCommit: async () => ({ notAGitCheckout: true }),
      fetchRemoteCommit: async () => ({ error: "x" }),
    });
    const body = await res.json();
    assert.equal(body.state, "apply-failed");
    assert.ok(body.message);
  });

  test("always returns HTTP 200 except the 403 — a failed check is data, not an HTTP error", async () => {
    const res = await handleUpdatesGet(fakeReq(), {
      isLoopbackRequest: () => true,
      readApplyState: () => ({ phase: "idle" }),
      getLocalCommit: async () => ({ sha: LOCAL_SHA }),
      fetchRemoteCommit: async () => ({ error: "network down" }),
    });
    assert.equal(res.status, 200);
  });
});
