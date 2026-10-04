import { describe, test, after } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";
import {
  logTail,
  startLocalEmbeddingsJob,
  startLocalIndexUpdateIfInUse,
  type StartLocalEmbeddingsDeps,
} from "../startLocalEmbeddings";
import {
  acquireLocalEmbeddingsLock,
  isLocalEmbeddingsRunning,
  localEmbeddingsPaths,
  readLocalEmbeddingsJob,
  writeLocalEmbeddingsJob,
  type LocalEmbeddingsJob,
  type LocalEmbeddingsStatus,
} from "../localEmbeddings";

/** Spawning the detached job: lock handling, the spawn contract, and early-exit reporting. No real job runs. */

function fakeChild(pid = 4242) {
  const child = new EventEmitter() as unknown as ChildProcess;
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
  let job: LocalEmbeddingsJob = { finishedAt: "2026-09-01T00:00:00.000Z", lastError: "old error", errorKind: "embed-failed" };
  const spawns: Array<{ cmd: string; args: string[]; opts: Record<string, any> }> = [];
  const child = fakeChild();
  const d: StartLocalEmbeddingsDeps = {
    baseDir: "/scaffold",
    acquireLock: () => (events.push("acquire"), true),
    releaseLock: () => void events.push("release"),
    transferLock: (pid) => void events.push(`transfer:${pid}`),
    readJob: () => job,
    writeJob: (j) => {
      job = j;
      jobs.push(j);
    },
    spawn: (cmd, args, opts) => {
      spawns.push({ cmd, args, opts });
      return child;
    },
    openLog: () => 99,
    closeLog: (fd) => void events.push(`close:${fd}`),
    readLogTail: () => "node:internal/modules/run_main\nError [ERR_MODULE_NOT_FOUND]: Cannot find package 'tsx'\n    at packageResolve (node:internal)\n",
    now: () => new Date("2026-10-04T00:00:00.000Z"),
    ...over,
  };
  return { d, events, jobs, spawns, child, setJob: (j: LocalEmbeddingsJob) => (job = j) };
}

describe("startLocalEmbeddingsJob", () => {
  test("takes the lock, clears the old error, spawns the job detached with its output going to the log, hands it the lock", () => {
    const { d, events, jobs, spawns, child } = fakeDeps();
    assert.deepEqual(startLocalEmbeddingsJob(d), { started: true });
    assert.deepEqual(events, ["acquire", "close:99", "transfer:4242"]);
    assert.deepEqual(jobs, [{ stage: "checking", startedAt: "2026-10-04T00:00:00.000Z", finishedAt: "2026-09-01T00:00:00.000Z" }]);
    assert.equal(spawns.length, 1);
    assert.equal(spawns[0].cmd, process.execPath);
    assert.deepEqual(spawns[0].args, ["--import", "tsx", "scripts/local-embeddings-job.mjs"]);
    assert.equal(spawns[0].opts.cwd, "/scaffold");
    assert.equal(spawns[0].opts.detached, true);
    assert.deepEqual(spawns[0].opts.stdio, ["ignore", 99, 99]);
    assert.equal(spawns[0].opts.env.GRANTED_LOCAL_EMBEDDINGS_LOCK_HELD, "1");
    assert.equal((child as any).unrefCalled, true);
  });

  test("no log available → output discarded, still starts", () => {
    const { d, spawns } = fakeDeps({ openLog: () => null });
    startLocalEmbeddingsJob(d);
    assert.equal(spawns[0].opts.stdio, "ignore");
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
    assert.ok(events.includes("release"));
  });

  test("the child failing to start records a Retry-able error and releases the lock", () => {
    const { d, events, jobs, child } = fakeDeps();
    startLocalEmbeddingsJob(d);
    child.emit("error", new Error("spawn ENOENT"));
    assert.equal(events.at(-1), "release");
    const last = jobs.at(-1)!;
    assert.match(last.lastError!, /Couldn't start local search setup: spawn ENOENT\. Click Retry\./);
    assert.equal(last.stage, undefined);
  });

  test("the child exiting early without recording an outcome → lastError with the log's last line, lock released", () => {
    const { d, events, jobs, child } = fakeDeps();
    startLocalEmbeddingsJob(d);
    child.emit("exit", 1);
    const last = jobs.at(-1)!;
    assert.equal(last.errorKind, "crashed");
    assert.match(last.lastError!, /stopped unexpectedly \(exit code 1\).*Cannot find package 'tsx'.*Click Retry/);
    assert.doesNotMatch(last.lastError!, /packageResolve/, "stack frames are dropped");
    assert.equal(events.at(-1), "release");
  });

  test("a handled failure (the job wrote its own lastError) or a clean exit is left alone", () => {
    const handled = fakeDeps();
    startLocalEmbeddingsJob(handled.d);
    handled.setJob({ lastError: "Couldn't reach Ollama", errorKind: "ollama-unreachable" });
    const before = handled.jobs.length;
    handled.child.emit("exit", 1);
    assert.equal(handled.jobs.length, before);
    assert.ok(!handled.events.slice(1).includes("release"));

    const clean = fakeDeps();
    startLocalEmbeddingsJob(clean.d);
    const n = clean.jobs.length;
    clean.child.emit("exit", 0);
    assert.equal(clean.jobs.length, n);
  });

  test("logTail keeps the last meaningful lines, short", () => {
    assert.equal(logTail("a\n\nb\n  at frame (x)\nc\n"), "b c");
    assert.ok(logTail("x".repeat(1000)).length <= 243);
  });
});

describe("a job that died without anyone listening still shows as failed (derived from disk)", () => {
  const dirs: string[] = [];
  after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

  test("stage written + lock gone + no outcome → 'crashed' failure, not a silent 'needed'", async () => {
    const { buildLocalEmbeddingsStatus } = await import("../localEmbeddings");
    const saved = { e: process.env.EMBEDDINGS_BASE_URL, p: process.env.LLM_PROVIDER };
    delete process.env.EMBEDDINGS_BASE_URL;
    delete process.env.LLM_PROVIDER;
    try {
      const b = mkdtempSync(join(tmpdir(), "granted-crashed-"));
      dirs.push(b);
      assert.equal(acquireLocalEmbeddingsLock(b), true);
      writeLocalEmbeddingsJob({ stage: "checking", startedAt: "2026-10-04T00:00:00.000Z" }, b);
      assert.equal(buildLocalEmbeddingsStatus(b).state, "running");
      // The child died: the lock now names a pid that no longer exists.
      writeFileSync(localEmbeddingsPaths(b).lockPath, JSON.stringify({ pid: 2 ** 30, startedAt: 1 }));
      assert.equal(isLocalEmbeddingsRunning(b), false);
      const s = buildLocalEmbeddingsStatus(b);
      assert.equal(s.state, "failed");
      assert.equal(s.errorKind, "crashed");
      assert.match(s.error!, /stopped unexpectedly.*local-embeddings-job\.log/);
      assert.equal(readLocalEmbeddingsJob(b).stage, "checking");
    } finally {
      if (saved.e === undefined) delete process.env.EMBEDDINGS_BASE_URL;
      else process.env.EMBEDDINGS_BASE_URL = saved.e;
      if (saved.p === undefined) delete process.env.LLM_PROVIDER;
      else process.env.LLM_PROVIDER = saved.p;
    }
  });
});

describe("startLocalIndexUpdateIfInUse (after data:refresh)", () => {
  const status = (s: Partial<LocalEmbeddingsStatus>): LocalEmbeddingsStatus => ({ state: "ready", model: "nomic-embed-text", active: true, ...s });

  test("starts an update only when search is on the local index and the refresh made it outdated", () => {
    let starts = 0;
    const start = () => (starts++, { started: true as const });
    assert.deepEqual(startLocalIndexUpdateIfInUse({ buildStatus: () => status({ outdated: true }), start }), { started: true });
    assert.equal(startLocalIndexUpdateIfInUse({ buildStatus: () => status({ outdated: false }), start }), null);
    assert.equal(startLocalIndexUpdateIfInUse({ buildStatus: () => status({ outdated: true, active: false }), start }), null, "on Cloud");
    assert.equal(startLocalIndexUpdateIfInUse({ buildStatus: () => status({ state: "needed" }), start }), null, "never built");
    assert.equal(startLocalIndexUpdateIfInUse({ buildStatus: () => status({ state: "not-applicable" }), start }), null);
    assert.equal(starts, 1);
  });
});
