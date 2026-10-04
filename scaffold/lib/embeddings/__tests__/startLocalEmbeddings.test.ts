import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { startLocalEmbeddingsJob, type StartLocalEmbeddingsDeps } from "../startLocalEmbeddings";
import type { LocalEmbeddingsJob } from "../localEmbeddings";

/** Spawning the detached job: lock handling and the spawn contract. No real process is started. */

function fakeChild(pid = 4242) {
  const child = new EventEmitter() as unknown as ChildProcess & { unrefCalled: boolean };
  (child as any).pid = pid;
  (child as any).unrefCalled = false;
  (child as any).unref = () => {
    (child as any).unrefCalled = true;
  };
  return child;
}

function fakeDeps(over: Partial<StartLocalEmbeddingsDeps> = {}) {
  const events: string[] = [];
  const jobs: LocalEmbeddingsJob[] = [];
  const spawns: Array<{ cmd: string; args: string[]; opts: Record<string, any> }> = [];
  const child = fakeChild();
  const d: StartLocalEmbeddingsDeps = {
    baseDir: "/scaffold",
    acquireLock: () => (events.push("acquire"), true),
    releaseLock: () => void events.push("release"),
    transferLock: (pid) => void events.push(`transfer:${pid}`),
    readJob: () => ({ finishedAt: "2026-09-01T00:00:00.000Z", lastError: "old error", errorKind: "embed-failed" }),
    writeJob: (job) => void jobs.push(job),
    spawn: (cmd, args, opts) => {
      spawns.push({ cmd, args, opts });
      return child;
    },
    now: () => new Date("2026-10-04T00:00:00.000Z"),
    ...over,
  };
  return { d, events, jobs, spawns, child };
}

describe("startLocalEmbeddingsJob", () => {
  test("takes the lock, clears the old error, spawns the job detached and hands it the lock", () => {
    const { d, events, jobs, spawns, child } = fakeDeps();
    assert.deepEqual(startLocalEmbeddingsJob(d), { started: true });
    assert.deepEqual(events, ["acquire", "transfer:4242"]);
    assert.deepEqual(jobs, [{ stage: "checking", startedAt: "2026-10-04T00:00:00.000Z", finishedAt: "2026-09-01T00:00:00.000Z" }]);
    assert.equal(spawns.length, 1);
    assert.equal(spawns[0].cmd, process.execPath);
    assert.deepEqual(spawns[0].args, ["--import", "tsx", "scripts/local-embeddings-job.mjs"]);
    assert.equal(spawns[0].opts.cwd, "/scaffold");
    assert.equal(spawns[0].opts.detached, true);
    assert.equal(spawns[0].opts.stdio, "ignore");
    assert.equal(spawns[0].opts.env.GRANTED_LOCAL_EMBEDDINGS_LOCK_HELD, "1");
    assert.equal((child as any).unrefCalled, true);
  });

  test("already running → no second job", () => {
    const { d, spawns } = fakeDeps({ acquireLock: () => false });
    assert.deepEqual(startLocalEmbeddingsJob(d), { started: false, reason: "running" });
    assert.equal(spawns.length, 0);
  });

  test("spawn throwing releases the lock and rethrows", () => {
    const { d, events } = fakeDeps({
      spawn: () => {
        throw new Error("EACCES");
      },
    });
    assert.throws(() => startLocalEmbeddingsJob(d), /EACCES/);
    assert.deepEqual(events, ["acquire", "release"]);
  });

  test("the child failing to start records a Retry-able error and releases the lock", () => {
    const { d, events, jobs, child } = fakeDeps();
    startLocalEmbeddingsJob(d);
    child.emit("error", new Error("spawn ENOENT"));
    assert.equal(events.at(-1), "release");
    const last = jobs.at(-1)!;
    assert.match(last.lastError!, /Couldn't start local search setup: spawn ENOENT\. Click Retry\./);
    assert.equal(last.errorKind, "unknown");
  });
});
