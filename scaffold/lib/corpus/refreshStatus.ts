import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

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

export interface RefreshStatus {
  lastError?: string;
  lastCompletedAt?: string;
  /** Set at the START of every refresh attempt (success or failure), not just
   *  on failure, so a child that crashes before writing its own status still
   *  triggers auto-update backoff (autoUpdate.ts). A successful completion
   *  overwrites the whole status with only `lastCompletedAt`, clearing this. */
  lastAttemptAt?: string;
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
  writeFileSync(statusPath(baseDir), JSON.stringify(status, null, 2));
}
