/**
 * Integration: the REAL install-windows.ps1 status code (Write-Status, as
 * extracted from the actual file — same approach as install-windows.tests.ps1,
 * so this can't drift from what ships) running in a real powershell.exe,
 * read back through the app's own readTaskStatus/decideStatusPoll.
 *
 * Covers the bug a real Windows 11 run hit: the GUI gave up on an install
 * that was sitting at a UAC prompt for 12+ minutes, and a second click then
 * started a concurrent install. The window's pid in the status file is what
 * lets the GUI keep waiting while it's alive and react at once if it's closed.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { decideStatusPoll, TASK_WINDOW_CLOSED_MESSAGE } from "../ipcPure";
import { readStatusFile, readTaskStatus } from "../openGranted";

const execFileAsync = promisify(execFile);

// `npm test` runs from installer/; the script lives at the repo root.
const INSTALL_SCRIPT = resolve(process.cwd(), "..", "install-windows.ps1");
const BOUNDARY = 'Write-Status "running" $null';

/** Everything in install-windows.ps1 before its first action: $StatusPath, Write-Status, Die, the trap. */
function realHeaderBlock(): string {
  const source = readFileSync(INSTALL_SCRIPT, "utf8");
  const at = source.indexOf(BOUNDARY);
  assert.ok(at > 0, `install-windows.ps1 no longer contains '${BOUNDARY}' — update this test's extraction`);
  return source.slice(0, at);
}

const POLL_OPTS = {
  startedTimeoutMs: 10_000,
  overallTimeoutMs: 10 * 60_000,
  notStartedMessage: "not started",
  timedOutMessage: "timed out",
};

describe(
  "install-windows.ps1's status file, read by the app",
  { skip: (process.platform !== "win32" || !existsSync(INSTALL_SCRIPT)) && "Windows only, run from installer/" },
  () => {
    let dir: string;
    before(async () => {
      dir = await mkdtemp(join(tmpdir(), "granted-install-status-it-"));
    });
    after(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    async function writeCase(name: string, action: string): Promise<{ script: string; status: string }> {
      const script = join(dir, `${name}.ps1`);
      const status = join(dir, `${name}-status.json`);
      await writeFile(script, `${realHeaderBlock()}\n${action}\n`, "utf8");
      return { script, status };
    }

    const PS = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File"];

    test("each write records the install window's own pid", async () => {
      const { script, status } = await writeCase("done", 'Write-Status "running" $null; Write-Status "done" $null');
      await execFileAsync("powershell.exe", [...PS, script], {
        env: { ...process.env, GRANTED_STATUS_FILE: status },
        windowsHide: true,
      });
      const parsed = await readStatusFile(status);
      assert.equal(parsed?.state, "done");
      assert.ok(Number.isInteger(parsed?.pid) && parsed!.pid! > 0 && parsed!.pid !== process.pid);
    });

    test("a live install window is waited on past the old 10-minute limit; once closed it's reported at once", async () => {
      // Stands in for an install sitting at a UAC prompt.
      const { script, status } = await writeCase("waiting", 'Write-Status "running" $null; Start-Sleep -Seconds 120');
      const window = spawn("powershell.exe", [...PS, script], {
        env: { ...process.env, GRANTED_STATUS_FILE: status },
        windowsHide: true,
        stdio: "ignore",
      });
      try {
        let running = null;
        for (let i = 0; i < 100 && running?.state !== "running"; i++) {
          await new Promise((r) => setTimeout(r, 200));
          running = await readTaskStatus(status);
        }
        assert.equal(running?.state, "running");
        assert.equal(running?.pid, window.pid);
        // Alive: no verdict even "30 minutes" in — the GUI keeps waiting.
        assert.equal(decideStatusPoll({ ...POLL_OPTS, status: running, elapsedMs: 30 * 60_000, sawRunning: true }), null);

        // The user closes the window: PowerShell dies without writing done/error.
        await execFileAsync("taskkill.exe", ["/PID", String(window.pid), "/T", "/F"]);
        await new Promise((r) => setTimeout(r, 500));
        const closed = await readTaskStatus(status);
        assert.deepEqual(closed, { state: "error", message: TASK_WINDOW_CLOSED_MESSAGE, pid: window.pid });
        assert.deepEqual(decideStatusPoll({ ...POLL_OPTS, status: closed, elapsedMs: 31 * 60_000, sawRunning: true }), {
          state: "error",
          message: TASK_WINDOW_CLOSED_MESSAGE,
        });
      } finally {
        window.kill();
      }
    });
  },
);
