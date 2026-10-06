/**
 * Integration: the REAL install-macos.sh status/lock code (write_status, the
 * STATUS_LOCK_DIR mkdir, the cleanup EXIT trap — as extracted from the
 * actual file, so this can't drift from what ships) running in a real bash,
 * read back through the app's own isStatusWindowAlive/readTaskStatus — the
 * macOS mirror of installStatus.integration.test.ts.
 *
 * Covers the same class of bug that test exists for on Windows (a GUI that
 * gives up on a still-alive window and double-launches), but for macOS's own
 * mechanism: there's no OS-level exclusive file lock to open here (no
 * flock(1) on a stock Mac), so liveness is a `<status>.lock.d` directory
 * (mkdir'd atomically, removed by bash's own EXIT trap) plus the recorded
 * pid — verified against two real signals: SIGTERM (closing a Terminal
 * window; bash's EXIT trap fires and removes the directory, which is enough
 * on its own) and SIGKILL (uncatchable; the directory survives, and the pid
 * check is what still correctly reports it as gone).
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { macStatusLockPath } from "../ipcPure";
import { isStatusWindowAlive, readStatusFile, readTaskStatus } from "../openGranted";

const execFileAsync = promisify(execFile);

// `npm test` runs from installer/; the script lives at the repo root.
const INSTALL_SCRIPT = resolve(process.cwd(), "..", "install-macos.sh");
const BOUNDARY = 'log "Granted — macOS install"';

/** Everything in install-macos.sh before its first action: STATUS_PATH, write_status, die, the traps. */
function realHeaderBlock(): string {
  const source = readFileSync(INSTALL_SCRIPT, "utf8");
  const at = source.indexOf(BOUNDARY);
  assert.ok(at > 0, `install-macos.sh no longer contains '${BOUNDARY}' — update this test's extraction`);
  return source.slice(0, at);
}

test("install-macos.sh takes the same STATUS_LOCK_DIR directory lock the app's own macStatusLockPath expects", { skip: !existsSync(INSTALL_SCRIPT) && "run from installer/" }, () => {
  // The two must not drift: the app's liveness check (isStatusWindowAlive)
  // looks for exactly this directory suffix.
  const header = realHeaderBlock();
  assert.match(header, /STATUS_LOCK_DIR="\$\{STATUS_PATH\}\.lock\.d"/, "install-macos.sh must define STATUS_LOCK_DIR as STATUS_PATH + the exact suffix macStatusLockPath uses");
  assert.equal(macStatusLockPath("/tmp/x.json"), "/tmp/x.json.lock.d");
  assert.ok(header.indexOf("STATUS_LOCK_DIR=") > header.indexOf("STATUS_PATH="), "after STATUS_PATH is set");
  assert.ok(header.indexOf('mkdir "$STATUS_LOCK_DIR"') > header.indexOf("STATUS_LOCK_DIR="), "mkdir'd right after");
  assert.match(header, /trap cleanup EXIT/, "removed by an EXIT trap");
});

describe(
  "install-macos.sh's status file and lock directory, read by the app",
  { skip: (process.platform !== "darwin" || !existsSync(INSTALL_SCRIPT)) && "macOS only, run from installer/" },
  () => {
    let dir: string;
    before(async () => {
      dir = await mkdtemp(join(tmpdir(), "granted-install-status-mac-it-"));
    });
    after(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    async function writeCase(name: string, action: string): Promise<{ script: string; status: string }> {
      const script = join(dir, `${name}.sh`);
      const status = join(dir, `${name}-status.json`);
      await writeFile(script, `${realHeaderBlock()}\n${action}\n`, "utf8");
      return { script, status };
    }

    test("each write records the window's own pid", async () => {
      const { script, status } = await writeCase("done", 'write_status "running" ""\nwrite_status "done" ""');
      await execFileAsync("bash", [script], { env: { ...process.env, GRANTED_STATUS_FILE: status } });
      const parsed = await readStatusFile(status);
      assert.equal(parsed?.state, "done");
      assert.ok(Number.isInteger(parsed?.pid) && parsed!.pid! > 0 && parsed!.pid !== process.pid);
    });

    test("a live window is reported alive (lock directory present, pid alive); closing it with SIGTERM is reported as closed at once", async () => {
      // Stands in for an install sitting mid-step.
      const { script, status } = await writeCase("waiting", 'write_status "running" ""\nsleep 120');
      const window = spawn("bash", [script], { env: { ...process.env, GRANTED_STATUS_FILE: status }, stdio: "ignore" });
      try {
        let running = null;
        for (let i = 0; i < 100 && running?.state !== "running"; i++) {
          await new Promise((r) => setTimeout(r, 200));
          running = await readTaskStatus(status);
        }
        assert.equal(running?.state, "running");
        assert.equal(running?.pid, window.pid);
        assert.ok(existsSync(macStatusLockPath(status)), "the real script took its directory lock");
        assert.equal(isStatusWindowAlive(status, window.pid!), true);

        // The user closes the window: bash receives SIGTERM, its EXIT trap
        // fires (removing the lock directory) without ever writing done/error.
        window.kill("SIGTERM");
        await new Promise((r) => setTimeout(r, 1000));
        assert.equal(existsSync(macStatusLockPath(status)), false, "the EXIT trap removed the lock directory");
        const closed = await readTaskStatus(status);
        assert.equal(closed?.state, "error");
        assert.equal(closed?.closed, true);
      } finally {
        window.kill("SIGKILL");
      }
    });

    test("SIGKILL (which no trap can catch) leaves the lock directory behind — the pid is still what correctly reports it as closed", async () => {
      const { script, status } = await writeCase("killed", 'write_status "running" ""\nsleep 120');
      const window = spawn("bash", [script], { env: { ...process.env, GRANTED_STATUS_FILE: status }, stdio: "ignore" });
      try {
        let running = null;
        for (let i = 0; i < 100 && running?.state !== "running"; i++) {
          await new Promise((r) => setTimeout(r, 200));
          running = await readTaskStatus(status);
        }
        assert.equal(running?.state, "running");
        window.kill("SIGKILL");
        await new Promise((r) => setTimeout(r, 1000));
        assert.ok(existsSync(macStatusLockPath(status)), "no trap caught SIGKILL — the directory is still there");
        // The directory alone doesn't prove it's alive; the pid does.
        assert.equal(isStatusWindowAlive(status, window.pid!), false);
        const closed = await readTaskStatus(status);
        assert.equal(closed?.state, "error");
        assert.equal(closed?.closed, true);
      } finally {
        window.kill("SIGKILL");
      }
    });
  },
);
