import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RefreshStage } from "./refreshProgress";

/** Single-flight refresh lock: an O_EXCL file holding the owner's pid, stale once that pid is gone. */
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
function stopRequestPath(baseDir: string): string {
  return join(dir(baseDir), "refresh-stop-request");
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
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
  try {
    unlinkSync(p);
  } catch {
    /* already gone */
  }
  return false;
}

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
  if (isRefreshing(baseDir)) return false;
  try {
    writeFileSync(p, JSON.stringify(info), { flag: "wx" });
    return true;
  } catch {
    return false;
  }
}

export function transferRefreshLock(pid: number, baseDir: string = process.cwd()): void {
  const p = lockPath(baseDir);
  try {
    const info = JSON.parse(readFileSync(p, "utf8")) as LockInfo;
    writeFileSync(p, JSON.stringify({ ...info, pid }));
  } catch {
    /* already released */
  }
}

export function releaseRefreshLock(baseDir: string = process.cwd()): void {
  try {
    unlinkSync(lockPath(baseDir));
  } catch {
    /* already gone */
  }
}

export interface RefreshProgress {
  stage: RefreshStage;
  done?: number;
  total?: number;
  pct: number;
  /** Running count of open (non-expired) opportunities found so far. */
  foundCount?: number;
  /** Set once selection has run: how many of `foundCount` were kept under the cap. */
  keptCount?: number;
}

export interface RefreshStatus {
  lastError?: string;
  lastCompletedAt?: string;
  /** Written when an attempt starts; a successful run (or a user stop) clears it. */
  lastAttemptAt?: string;
  /** Live progress while a refresh is running; absent once it finishes. */
  progress?: RefreshProgress;
  /** Set on the final status write when the user stopped the refresh — never alongside lastError. */
  stopped?: boolean;
  /** Present when `stopped` is true: how many records the partial save wrote (0 if none). */
  savedCount?: number;
}

export function readRefreshStatus(baseDir: string = process.cwd()): RefreshStatus {
  try {
    return JSON.parse(readFileSync(statusPath(baseDir), "utf8"));
  } catch {
    return {};
  }
}

export function writeRefreshStatus(status: RefreshStatus, baseDir: string = process.cwd()): void {
  mkdirSync(dir(baseDir), { recursive: true });
  const p = statusPath(baseDir);
  const tmp = `${p}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(status, null, 2));
  renameSync(tmp, p);
}

/** Merges just the `progress` field into the status file, leaving lastError/lastAttemptAt etc. untouched. */
export function writeRefreshProgress(progress: RefreshProgress, baseDir: string = process.cwd()): void {
  writeRefreshStatus({ ...readRefreshStatus(baseDir), progress }, baseDir);
}

/** Requests that a running refresh stop; checked by the script between detail-fetch and embedding batches. */
export function requestStop(baseDir: string = process.cwd()): void {
  mkdirSync(dir(baseDir), { recursive: true });
  writeFileSync(stopRequestPath(baseDir), String(Date.now()));
}

export function isStopRequested(baseDir: string = process.cwd()): boolean {
  return existsSync(stopRequestPath(baseDir));
}

/** Cleared both when a refresh starts (a stale request from a prior run must never stop a new one)
 *  and when a stopped run finishes handling it. */
export function clearStopRequest(baseDir: string = process.cwd()): void {
  try {
    unlinkSync(stopRequestPath(baseDir));
  } catch {
    /* already gone */
  }
}
