import { spawn, type ChildProcess } from "node:child_process";
import {
  acquireLocalEmbeddingsLock,
  localEmbeddingsBaseDir,
  readLocalEmbeddingsJob,
  releaseLocalEmbeddingsLock,
  transferLocalEmbeddingsLock,
  writeLocalEmbeddingsJob,
} from "./localEmbeddings";

/**
 * Spawns scripts/local-embeddings-job.mjs detached (same pattern as POST
 * /api/corpus/refresh): the lock is taken here so two clicks can't start two
 * jobs, then handed to the child's pid. Shared by POST /api/llm/embeddings and
 * the switch to Local in POST /api/llm/config.
 */
export type StartLocalEmbeddingsDeps = {
  baseDir: string;
  acquireLock: (baseDir: string) => boolean;
  releaseLock: (baseDir: string) => void;
  transferLock: (pid: number, baseDir: string) => void;
  readJob: typeof readLocalEmbeddingsJob;
  writeJob: typeof writeLocalEmbeddingsJob;
  spawn: (command: string, args: string[], options: Record<string, unknown>) => ChildProcess;
  now: () => Date;
};

function realDeps(): StartLocalEmbeddingsDeps {
  return {
    baseDir: localEmbeddingsBaseDir(),
    acquireLock: (baseDir) => acquireLocalEmbeddingsLock(baseDir),
    releaseLock: releaseLocalEmbeddingsLock,
    transferLock: transferLocalEmbeddingsLock,
    readJob: readLocalEmbeddingsJob,
    writeJob: writeLocalEmbeddingsJob,
    spawn,
    now: () => new Date(),
  };
}

export type StartResult = { started: true } | { started: false; reason: "running" };

export function startLocalEmbeddingsJob(deps: Partial<StartLocalEmbeddingsDeps> = {}): StartResult {
  const d = { ...realDeps(), ...deps };
  if (!d.acquireLock(d.baseDir)) return { started: false, reason: "running" };

  // Clear the previous attempt's error up front, so the UI flips to "running" immediately.
  const previous = d.readJob(d.baseDir);
  const startedAt = d.now().toISOString();
  let child: ChildProcess;
  try {
    d.writeJob({ stage: "checking", startedAt, ...(previous.finishedAt ? { finishedAt: previous.finishedAt } : {}) }, d.baseDir);
    child = d.spawn(process.execPath, ["--import", "tsx", "scripts/local-embeddings-job.mjs"], {
      cwd: d.baseDir,
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: { ...process.env, GRANTED_LOCAL_EMBEDDINGS_LOCK_HELD: "1" },
    });
  } catch (e) {
    d.releaseLock(d.baseDir);
    throw e;
  }
  child.on("error", (e) => {
    try {
      d.writeJob(
        {
          startedAt,
          lastError: `Couldn't start local search setup: ${e.message}. Click Retry.`,
          errorKind: "unknown",
          lastFailedAt: d.now().toISOString(),
        },
        d.baseDir,
      );
    } finally {
      d.releaseLock(d.baseDir);
    }
  });
  if (typeof child.pid === "number") d.transferLock(child.pid, d.baseDir);
  child.unref?.();
  return { started: true };
}
