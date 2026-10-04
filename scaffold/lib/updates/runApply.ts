import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import type { SpawnFn } from "./git";
import { setApplyPhase, markApplyDone, markApplyFailed } from "./applyState";

/**
 * lib/updates/runApply.ts — runs `git pull --ff-only` then `npm ci` for the
 * one-click update apply (POST /api/updates/apply). Fire-and-forget by
 * design: the route calls `void runApplyInBackground()` without awaiting it
 * and returns 202 immediately, so this function must never throw — an
 * uncaught rejection here would surface as an unhandled promise rejection in
 * the server process, not an HTTP error. Progress is reported out-of-band
 * via lib/updates/applyState.ts, which GET /api/updates polls.
 *
 * Only ever runs `git pull --ff-only` — never a plain `git pull`, never
 * `git reset --hard`, never any force flag. A failed pull stops here; npm
 * never runs after a failed pull.
 */
export type RunApplyDeps = {
  /** Array-args-only `spawn`, same no-shell-string rule as lib/updates/git.ts. */
  spawn: SpawnFn;
  cwd: string;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  execPath: string;
};

const REAL_RUN_APPLY_DEPS: RunApplyDeps = {
  spawn: nodeSpawn,
  cwd: process.cwd(),
  env: process.env,
  platform: process.platform,
  execPath: process.execPath,
};

type CommandResult = { code: number | null; stdout: string; stderr: string };

/** Runs one command to completion, capturing stdout/stderr/exit code. Never throws/rejects — a
 *  `spawn` that throws synchronously, or emits an `'error'` event, resolves as a failed result
 *  (code: null) instead. */
function runCommand(command: string, args: string[], cwd: string, spawnImpl: SpawnFn): Promise<CommandResult> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (result: CommandResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    let child: ChildProcess;
    try {
      child = spawnImpl(command, args, { cwd, windowsHide: true });
    } catch (e: any) {
      settle({ code: null, stdout: "", stderr: e?.message ?? String(e) });
      return;
    }

    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: unknown) => {
      stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk: unknown) => {
      stderr += String(chunk);
    });
    child.on("error", (e: Error) => settle({ code: null, stdout, stderr: stderr || e.message }));
    child.on("close", (code: number | null) => settle({ code, stdout, stderr }));
  });
}

export async function runApplyInBackground(deps: Partial<RunApplyDeps> = {}): Promise<void> {
  const d = { ...REAL_RUN_APPLY_DEPS, ...deps };
  try {
    const pull = await runCommand("git", ["pull", "--ff-only"], d.cwd, d.spawn);
    if (pull.code !== 0) {
      markApplyFailed(pull.stderr || pull.stdout || `git pull exited with code ${pull.code}`);
      return;
    }

    setApplyPhase("installing");

    // Windows gotcha: plain spawn("npm", [...]) fails with ENOENT there because the real
    // entrypoint is npm.cmd, not npm — and array-args-only (no shell: true) rules out the usual
    // shell:true workaround. npm sets npm_execpath on every child it spawns, which is guaranteed
    // here since this server process was itself started via `npm run dev`/`start`, so re-invoke
    // through that same script via node (d.execPath) instead of guessing the npm binary name.
    const npmExecpath = d.env.npm_execpath;
    const npmCommand = npmExecpath ? d.execPath : d.platform === "win32" ? "npm.cmd" : "npm";
    const npmArgs = npmExecpath ? [npmExecpath, "ci"] : ["ci"];

    const npm = await runCommand(npmCommand, npmArgs, d.cwd, d.spawn);
    if (npm.code !== 0) {
      markApplyFailed(npm.stderr || npm.stdout || `npm ci exited with code ${npm.code}`);
      return;
    }

    markApplyDone();
  } catch (e: any) {
    markApplyFailed(e?.message ?? "Update failed unexpectedly.");
  }
}
