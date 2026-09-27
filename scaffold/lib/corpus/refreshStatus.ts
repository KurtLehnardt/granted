import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Single-flight lock + last-run status for `npm run data:refresh`, shared by
 * the script (scripts/refresh-corpus.mjs) and GET/POST /api/corpus. A bare
 * lock file (not a pid check — the refresh may run as a detached child of a
 * short-lived Next request handler) that self-heals if a run crashed without
 * releasing it.
 */
const STALE_LOCK_MS = 30 * 60 * 1000;

function dir(baseDir: string): string {
  return join(baseDir, "data", "local");
}
function lockPath(baseDir: string): string {
  return join(dir(baseDir), "refresh.lock");
}
function statusPath(baseDir: string): string {
  return join(dir(baseDir), "refresh-status.json");
}

export function isRefreshing(baseDir: string = process.cwd()): boolean {
  const p = lockPath(baseDir);
  if (!existsSync(p)) return false;
  try {
    return Date.now() - Number(readFileSync(p, "utf8")) < STALE_LOCK_MS;
  } catch {
    return false;
  }
}

/** Atomically claim the lock. Returns false if another run already holds it. */
export function acquireRefreshLock(baseDir: string = process.cwd()): boolean {
  mkdirSync(dir(baseDir), { recursive: true });
  if (isRefreshing(baseDir)) return false;
  writeFileSync(lockPath(baseDir), String(Date.now()));
  return true;
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
