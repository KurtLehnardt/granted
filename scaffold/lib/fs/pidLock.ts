import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { readJsonFile, writeFileAtomic } from "./atomicFile";

/**
 * Cross-process single-flight lock: a file holding `{ pid, startedAt }`,
 * created with O_EXCL. Shared by the corpus refresh (data/local/refresh.lock)
 * and the local-embeddings job (data/local/local-embeddings.lock).
 *
 * Rules that keep a second job from ever starting on the same files:
 *   - A lock whose owner pid is alive is held.
 *   - A lock that can't be read yet (empty: created but not yet written, or
 *     mid-write) is HELD, never deleted, until it's older than
 *     `unreadableStaleMs` by mtime (a writer that died between create and write).
 *   - A legacy lock holding a bare timestamp is held until `legacyStaleMs` old.
 *   - Only a lock whose owner is gone is reclaimed, by one contender at a time
 *     (a short-lived `.reclaim` mutex), and only if it still holds the exact stale
 *     content, so a fresh lock another process just created is never deleted.
 *   - Handing the lock to a child pid rewrites it atomically (temp + rename),
 *     so a concurrent reader never sees it empty.
 */

export interface PidLockInfo {
  pid: number;
  startedAt: number;
}

export interface PidLockOptions {
  unreadableStaleMs?: number;
  legacyStaleMs?: number;
  /** Injectable for tests. */
  isProcessAlive?: (pid: number) => boolean;
  now?: () => number;
}

export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

type LockState = { kind: "absent" } | { kind: "held" } | { kind: "stale"; raw: string };

function inspect(lockPath: string, opts: Required<PidLockOptions>): LockState {
  let raw: string;
  let mtimeMs: number;
  try {
    raw = readFileSync(lockPath, "utf8");
    mtimeMs = statSync(lockPath).mtimeMs;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { kind: "absent" };
    return { kind: "held" }; // unreadable right now (Windows sharing violation) — assume held
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = undefined;
  }
  const now = opts.now();
  if (parsed && typeof parsed === "object" && typeof (parsed as PidLockInfo).pid === "number") {
    return opts.isProcessAlive((parsed as PidLockInfo).pid) ? { kind: "held" } : { kind: "stale", raw };
  }
  if (typeof parsed === "number") {
    return now - parsed > opts.legacyStaleMs ? { kind: "stale", raw } : { kind: "held" };
  }
  return now - mtimeMs > opts.unreadableStaleMs ? { kind: "stale", raw } : { kind: "held" };
}

export function createPidLock(lockPath: string, options: PidLockOptions = {}) {
  const opts: Required<PidLockOptions> = {
    unreadableStaleMs: options.unreadableStaleMs ?? 60_000,
    legacyStaleMs: options.legacyStaleMs ?? 30 * 60_000,
    isProcessAlive: options.isProcessAlive ?? isProcessAlive,
    now: options.now ?? Date.now,
  };

  function tryCreate(pid: number): boolean {
    mkdirSync(dirname(lockPath), { recursive: true });
    try {
      writeFileSync(lockPath, JSON.stringify({ pid, startedAt: opts.now() } satisfies PidLockInfo), { flag: "wx" });
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw e;
    }
  }

  /**
   * Remove a stale lock, safely against other contenders. Reclaimers serialize on a
   * tiny `<lock>.reclaim` mutex (O_EXCL, held for microseconds) and re-check the lock
   * under it: only the mutex holder ever deletes the lock file, and only if it still
   * holds exactly the stale content judged dead, so a fresh lock someone else just
   * created can never be deleted. Returns true when the stale lock is gone.
   */
  function reclaim(staleRaw: string): boolean {
    const mutex = `${lockPath}.reclaim`;
    try {
      writeFileSync(mutex, String(process.pid), { flag: "wx" });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") return false;
      // A reclaimer that died mid-reclaim leaves the mutex behind; it's only ever held for microseconds.
      try {
        if (opts.now() - statSync(mutex).mtimeMs > 10_000) unlinkSync(mutex);
      } catch {
        /* gone already */
      }
      return false;
    }
    try {
      let current: string;
      try {
        current = readFileSync(lockPath, "utf8");
      } catch {
        return true; // already gone
      }
      if (current !== staleRaw) return false; // someone reclaimed and re-created it meanwhile
      try {
        unlinkSync(lockPath);
      } catch {
        return false;
      }
      return true;
    } finally {
      try {
        unlinkSync(mutex);
      } catch {
        /* ignore */
      }
    }
  }

  return {
    path: lockPath,

    isHeld(): boolean {
      return inspect(lockPath, opts).kind === "held";
    },

    acquire(pid: number = process.pid): boolean {
      if (tryCreate(pid)) return true;
      const state = inspect(lockPath, opts);
      if (state.kind === "held") return false;
      if (state.kind === "stale" && !reclaim(state.raw)) return false;
      return tryCreate(pid);
    },

    /** Hand the lock to another pid (the spawned child). Atomic; a no-op if the lock is gone. */
    transfer(pid: number): void {
      const info = readJsonFile<PidLockInfo>(lockPath);
      if (!info || typeof info !== "object") return;
      try {
        writeFileAtomic(lockPath, JSON.stringify({ ...info, pid }), { fallback: "throw" });
      } catch {
        /* the current owner's pid stays in place: still a valid, held lock */
      }
    },

    release(): void {
      try {
        unlinkSync(lockPath);
      } catch {
        /* already gone */
      }
    },

    exists(): boolean {
      return existsSync(lockPath);
    },
  };
}

export type PidLock = ReturnType<typeof createPidLock>;
