import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Small file helpers shared by the corpus-refresh and local-embeddings state
 * files (lib/corpus/refreshStatus.ts, lib/embeddings/*). Path-parameterized,
 * synchronous, never throw on read.
 */

/** Parsed JSON, or null when the file is missing, empty or corrupt. */
export function readJsonFile<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

/** Synchronous sleep (no event loop) for short retry backoffs in sync code. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

let tmpCounter = 0;

/**
 * Write `body` to `path` via temp file + rename, so a reader sees the old or the
 * new content, never a half-written file. On Windows a rename over a file
 * another process has open fails transiently (EPERM/EACCES/EBUSY), so it's
 * retried a few times. If it still fails:
 *   - `fallback: "direct"` (cosmetic status files) writes the target in place;
 *   - `fallback: "throw"` (anything a reader must never see half-written,
 *     e.g. a lock) rethrows, leaving the old content intact.
 */
export function writeFileAtomic(
  path: string,
  body: string,
  opts: { fallback?: "direct" | "throw"; mode?: number; retries?: number } = {},
): void {
  const { fallback = "direct", mode, retries = 8 } = opts;
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}-${tmpCounter++}`;
  writeFileSync(tmp, body, mode != null ? { mode } : undefined);
  let lastErr: unknown;
  for (let i = 0; i <= retries; i++) {
    try {
      renameSync(tmp, path);
      return;
    } catch (e) {
      lastErr = e;
      if (i < retries) sleepSync(5 * (i + 1));
    }
  }
  rmSync(tmp, { force: true });
  if (fallback === "throw") throw lastErr;
  writeFileSync(path, body);
}
