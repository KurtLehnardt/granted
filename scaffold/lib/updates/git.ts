import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";

/**
 * lib/updates/git.ts — reads the local git checkout's current commit so the
 * update-check route (app/api/updates) can compare it against GitHub's main.
 *
 * Same subprocess-safety rule as app/api/corpus/refresh/handler.ts: `spawn`
 * is called with array args, never a shell string, so there's no shell
 * interpolation to worry about. `spawnImpl` is injectable for tests (no real
 * git process needed).
 */
export type SpawnFn = (command: string, args: string[], options: Record<string, unknown>) => ChildProcess;

export type LocalCommitResult = { sha: string } | { notAGitCheckout: true };

const FULL_SHA_RE = /^[0-9a-f]{40}$/i;

/**
 * Resolves `{sha}` when this is a git checkout with a resolvable HEAD;
 * resolves `{notAGitCheckout: true}` for anything else — a nonzero exit, a
 * `spawn` `'error'` event (git binary missing), or stdout that doesn't look
 * like a 40-hex-char commit SHA. Never throws or rejects: callers (the
 * /api/updates handler) treat "not a git checkout" as ordinary data, a
 * forward-compat hook for a future non-git install method, not an error.
 */
export function getLocalCommit(
  cwd: string = process.cwd(),
  spawnImpl: SpawnFn = nodeSpawn,
): Promise<LocalCommitResult> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (result: LocalCommitResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    let child: ChildProcess;
    try {
      child = spawnImpl("git", ["rev-parse", "HEAD"], { cwd, windowsHide: true });
    } catch {
      settle({ notAGitCheckout: true });
      return;
    }

    let stdout = "";
    child.stdout?.on("data", (chunk: unknown) => {
      stdout += String(chunk);
    });
    child.on("error", () => settle({ notAGitCheckout: true }));
    child.on("close", (code: number | null) => {
      const trimmed = stdout.trim();
      if (code === 0 && FULL_SHA_RE.test(trimmed)) settle({ sha: trimmed });
      else settle({ notAGitCheckout: true });
    });
  });
}
