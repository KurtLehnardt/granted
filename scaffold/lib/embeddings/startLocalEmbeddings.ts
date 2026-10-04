import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync } from "node:fs";
import {
  acquireLocalEmbeddingsLock,
  buildLocalEmbeddingsStatus,
  localEmbeddingsBaseDir,
  localEmbeddingsPaths,
  readLocalEmbeddingsJob,
  releaseLocalEmbeddingsLock,
  transferLocalEmbeddingsLock,
  writeLocalEmbeddingsJob,
  type LocalEmbeddingsStatus,
} from "./localEmbeddings";

/**
 * Spawns scripts/local-embeddings-job.mjs detached (same pattern as POST
 * /api/corpus/refresh): the lock is taken here so two clicks can't start two
 * jobs, then handed to the child's pid. Shared by POST /api/llm/embeddings, the
 * switch to Local in POST /api/llm/config, and the end of data:refresh.
 *
 * The child's stdout/stderr go to data/local/local-embeddings-job.log, and an
 * early non-zero exit (tsx missing under `next start`, an import crash) is
 * recorded as a Retry-able error with the log's tail, instead of the status
 * silently drifting back to "needed". (If this server is gone by then,
 * deriveLocalEmbeddingsStatus still reports the orphaned run as "crashed".)
 */
export type StartLocalEmbeddingsDeps = {
  baseDir: string;
  acquireLock: (baseDir: string) => boolean;
  releaseLock: (baseDir: string) => void;
  transferLock: (pid: number, baseDir: string) => void;
  readJob: typeof readLocalEmbeddingsJob;
  writeJob: typeof writeLocalEmbeddingsJob;
  spawn: (command: string, args: string[], options: Record<string, unknown>) => ChildProcess;
  /** Open the job's log for the child's stdout/stderr (fd), or null to discard output. */
  openLog: (baseDir: string) => number | null;
  closeLog: (fd: number) => void;
  readLogTail: (baseDir: string) => string;
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
    openLog: (baseDir) => {
      try {
        const { localDir, logPath } = localEmbeddingsPaths(baseDir);
        mkdirSync(localDir, { recursive: true });
        return openSync(logPath, "w");
      } catch {
        return null;
      }
    },
    closeLog: (fd) => {
      try {
        closeSync(fd);
      } catch {
        /* already closed */
      }
    },
    readLogTail: (baseDir) => {
      try {
        return readFileSync(localEmbeddingsPaths(baseDir).logPath, "utf8");
      } catch {
        return "";
      }
    },
    now: () => new Date(),
  };
}

/** Last meaningful line(s) of the child's output, short enough for the Settings panel. */
export function logTail(text: string, maxChars = 240): string {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((l) => !/^at\s/.test(l)) // stack frames
    .filter((l) => !/^Node\.js v\d/.test(l)) // node's crash footer
    .filter((l) => /[A-Za-z0-9]/.test(l)); // lone braces/punctuation from an error object dump
  // Node prints the error line, then its properties; the error line is what explains it.
  const errorLine = [...lines].reverse().find((l) => /\b\w*Error\b|^error:|Cannot find/i.test(l));
  const tail = errorLine ?? lines.slice(-2).join(" ");
  return tail.length > maxChars ? `...${tail.slice(-maxChars)}` : tail;
}

export type StartResult = { started: true } | { started: false; reason: "running" };

export function startLocalEmbeddingsJob(deps: Partial<StartLocalEmbeddingsDeps> = {}): StartResult {
  const d = { ...realDeps(), ...deps };
  if (!d.acquireLock(d.baseDir)) return { started: false, reason: "running" };

  // Clear the previous attempt's error up front, so the UI flips to "running" immediately.
  const previous = d.readJob(d.baseDir);
  const startedAt = d.now().toISOString();
  const carry = previous.finishedAt ? { finishedAt: previous.finishedAt } : {};
  const recordFailure = (message: string) => {
    d.writeJob(
      { startedAt, ...carry, lastError: message, errorKind: "crashed", lastFailedAt: d.now().toISOString() },
      d.baseDir,
    );
  };

  let child: ChildProcess;
  const logFd = d.openLog(d.baseDir);
  try {
    d.writeJob({ stage: "checking", startedAt, ...carry }, d.baseDir);
    child = d.spawn(process.execPath, ["--import", "tsx", "scripts/local-embeddings-job.mjs"], {
      cwd: d.baseDir,
      detached: true,
      stdio: logFd != null ? ["ignore", logFd, logFd] : "ignore",
      windowsHide: true,
      env: { ...process.env, GRANTED_LOCAL_EMBEDDINGS_LOCK_HELD: "1" },
    });
  } catch (e) {
    d.releaseLock(d.baseDir);
    throw e;
  } finally {
    if (logFd != null) d.closeLog(logFd); // the child holds its own copy
  }

  let settled = false;
  child.on("error", (e) => {
    if (settled) return;
    settled = true;
    try {
      recordFailure(`Couldn't start local search setup: ${e.message}. Click Retry.`);
    } finally {
      d.releaseLock(d.baseDir);
    }
  });
  child.on("exit", (code) => {
    if (settled || code === 0 || code == null) return;
    settled = true;
    // The job writes its own lastError on a handled failure; only fill in when it died without one.
    const job = d.readJob(d.baseDir);
    if (job.lastError || job.finishedAt !== carry.finishedAt) return;
    const detail = logTail(d.readLogTail(d.baseDir));
    try {
      recordFailure(
        `Local search setup stopped unexpectedly (exit code ${code})${detail ? `: ${detail}` : ""}. Click Retry.`,
      );
    } finally {
      d.releaseLock(d.baseDir); // the dead child can't release it any more
    }
  });
  if (typeof child.pid === "number") d.transferLock(child.pid, d.baseDir);
  child.unref?.();
  return { started: true };
}

/**
 * After a data:refresh: if search is currently using the Settings-built local index and
 * the refresh made it outdated, update it in the background (only new or changed grants
 * are re-embedded). A no-op on Cloud, before the index was ever built, or with
 * EMBEDDINGS_* in .env.local.
 */
export function startLocalIndexUpdateIfInUse(
  deps: { buildStatus?: () => LocalEmbeddingsStatus; start?: () => StartResult } = {},
): StartResult | null {
  const status = (deps.buildStatus ?? (() => buildLocalEmbeddingsStatus()))();
  if (status.state !== "ready" || !status.active || !status.outdated) return null;
  return (deps.start ?? (() => startLocalEmbeddingsJob()))();
}
