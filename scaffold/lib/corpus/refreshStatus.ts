import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RefreshStage } from "./refreshProgress";
import { readJsonFile, writeFileAtomic } from "../fs/atomicFile";
import { createPidLock } from "../fs/pidLock";

export { isProcessAlive } from "../fs/pidLock";

/** Single-flight refresh lock: see lib/fs/pidLock.ts. */
function dir(baseDir: string): string {
  return join(baseDir, "data", "local");
}
function lock(baseDir: string) {
  return createPidLock(join(dir(baseDir), "refresh.lock"));
}
function statusPath(baseDir: string): string {
  return join(dir(baseDir), "refresh-status.json");
}
function stopRequestPath(baseDir: string): string {
  return join(dir(baseDir), "refresh-stop-request");
}

export function isRefreshing(baseDir: string = process.cwd()): boolean {
  return lock(baseDir).isHeld();
}

export function acquireRefreshLock(baseDir: string = process.cwd(), pid: number = process.pid): boolean {
  return lock(baseDir).acquire(pid);
}

export function transferRefreshLock(pid: number, baseDir: string = process.cwd()): void {
  lock(baseDir).transfer(pid);
}

export function releaseRefreshLock(baseDir: string = process.cwd()): void {
  lock(baseDir).release();
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
  /** Written instead of lastCompletedAt when the user stopped the run; suppresses auto-refresh for a window (see shouldAutoRefresh). */
  lastStoppedAt?: string;
}

export function readRefreshStatus(baseDir: string = process.cwd()): RefreshStatus {
  return readJsonFile<RefreshStatus>(statusPath(baseDir)) ?? {};
}

export function writeRefreshStatus(status: RefreshStatus, baseDir: string = process.cwd()): void {
  // Windows refuses to rename over a file a reader (GET /api/corpus) has open; the status is cosmetic, so fall back to a direct write.
  writeFileAtomic(statusPath(baseDir), JSON.stringify(status, null, 2), { fallback: "direct" });
}

/** Merges `progress` into the status file; best-effort, swallows write errors since it's cosmetic. */
export function writeRefreshProgress(progress: RefreshProgress, baseDir: string = process.cwd()): void {
  try {
    writeRefreshStatus({ ...readRefreshStatus(baseDir), progress }, baseDir);
  } catch {
    /* cosmetic — never let a progress-bar write fail the refresh */
  }
}

/** Requests that a running refresh stop; checked by the script between detail-fetch and embedding batches. */
export function requestStop(baseDir: string = process.cwd()): void {
  mkdirSync(dir(baseDir), { recursive: true });
  writeFileSync(stopRequestPath(baseDir), String(Date.now()));
}

export function isStopRequested(baseDir: string = process.cwd()): boolean {
  return existsSync(stopRequestPath(baseDir));
}

/** Cleared when a refresh starts and again once a stopped run finishes handling it. */
export function clearStopRequest(baseDir: string = process.cwd()): void {
  try {
    unlinkSync(stopRequestPath(baseDir));
  } catch {
    /* already gone */
  }
}
