import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Single-flight lock + last-run status for `npm run data:refresh`, shared by
 * the script (scripts/refresh-corpus.mjs) and GET/POST /api/corpus. The lock
 * file holds the owning process's pid; staleness is "is that pid still
 * alive", not a fixed age, so a slow re-embed on modest hardware never gets
 * mistaken for a crashed run. Claiming is `wx` (O_EXCL) so two concurrent
 * claimants can't both succeed.
 */
interface LockInfo {
  pid: number;
  startedAt: number;
}

function dir(baseDir: string): string {
  return join(baseDir, "data", "local");
}
function lockPath(baseDir: string): string {
  return join(dir(baseDir), "refresh.lock");
}
function statusPath(baseDir: string): string {
  return join(dir(baseDir), "refresh-status.json");
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // Exists but owned by another user — still alive, just not signalable.
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function isRefreshing(baseDir: string = process.cwd()): boolean {
  const p = lockPath(baseDir);
  if (!existsSync(p)) return false;
  let info: Partial<LockInfo>;
  try {
    info = JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return false;
  }
  if (typeof info.pid === "number" && isProcessAlive(info.pid)) return true;
  // Owning process is gone without releasing the lock (crash) — self-heal.
  try {
    unlinkSync(p);
  } catch {
    /* already gone */
  }
  return false;
}

/** Atomically claim the lock for `pid` (O_EXCL). Returns false if another
 *  live run already holds it. */
export function acquireRefreshLock(baseDir: string = process.cwd(), pid: number = process.pid): boolean {
  mkdirSync(dir(baseDir), { recursive: true });
  const p = lockPath(baseDir);
  const info: LockInfo = { pid, startedAt: Date.now() };
  try {
    writeFileSync(p, JSON.stringify(info), { flag: "wx" });
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
  }
  if (isRefreshing(baseDir)) return false; // still held by a live process
  try {
    writeFileSync(p, JSON.stringify(info), { flag: "wx" }); // stale — self-healed above, re-claim
    return true;
  } catch {
    return false;
  }
}

/** Transfer the held lock to another pid (e.g. the detached child a request
 *  handler just spawned), so liveness tracks the actual long-running process
 *  instead of the short-lived request handler that claimed it first. */
export function transferRefreshLock(pid: number, baseDir: string = process.cwd()): void {
  const p = lockPath(baseDir);
  try {
    const info = JSON.parse(readFileSync(p, "utf8")) as LockInfo;
    writeFileSync(p, JSON.stringify({ ...info, pid }));
  } catch {
    /* lock vanished (e.g. the spawn itself failed) — nothing to transfer */
  }
}

export function releaseRefreshLock(baseDir: string = process.cwd()): void {
  try {
    unlinkSync(lockPath(baseDir));
  } catch {
    /* already gone */
  }
}

export interface RefreshStatus {
  lastError?: string;
  lastCompletedAt?: string;
  /** When the most recent refresh attempt started — set alongside `lastError`
   *  on failure so auto-update (components/CorpusAutoUpdate.tsx) can back off
   *  instead of retrying every page load. */
  lastAttemptAt?: string;
}

export function readRefreshStatus(baseDir: string = process.cwd()): RefreshStatus {
  try {
    return JSON.parse(readFileSync(statusPath(baseDir), "utf8"));
  } catch {
    return {};
  }
}

/** Replaces the status wholesale — a successful run clears any prior error. */
export function writeRefreshStatus(status: RefreshStatus, baseDir: string = process.cwd()): void {
  mkdirSync(dir(baseDir), { recursive: true });
  writeFileSync(statusPath(baseDir), JSON.stringify(status, null, 2));
}
