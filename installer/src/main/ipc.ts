import { clipboard, ipcMain } from "electron";
import type { WebContents } from "electron";
import { execFile, spawn } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import {
  INSTALL_ONE_LINERS,
  NODE_MAJOR_MIN,
  type InstallStatusEvent,
  type OpenInstallTerminalResult,
  type PrereqReport,
  type ToolCheckResult,
  isSupportedPlatform,
} from "../shared/ipc";

const execFileAsync = promisify(execFile);

/**
 * Runs `<cmd> --version` via array-arg execFile (never a shell string), and
 * extracts the first `major.minor.patch`-shaped version number it can find
 * in stdout. Missing binaries / non-zero exits are reported as
 * `present: false`, not thrown — a prereq check must never crash the UI.
 */
async function checkVersionedTool(cmd: string, args: string[]): Promise<ToolCheckResult> {
  try {
    const { stdout } = await execFileAsync(cmd, args, { timeout: 5000, windowsHide: true });
    const match = stdout.match(/(\d+)\.(\d+)\.(\d+)/);
    if (!match) {
      return { present: true, version: stdout.trim() || null, major: null };
    }
    return {
      present: true,
      version: match[0],
      major: Number.parseInt(match[1], 10),
    };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") {
      // Binary genuinely not found on PATH — the expected "not installed" case.
      return { present: false, version: null, major: null };
    }
    return {
      present: false,
      version: null,
      major: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function checkPrereqs(): Promise<PrereqReport> {
  const [git, node] = await Promise.all([
    checkVersionedTool("git", ["--version"]),
    checkVersionedTool("node", ["--version"]),
  ]);

  const nodeOk = node.present && node.major !== null && node.major >= NODE_MAJOR_MIN;

  return {
    platform: process.platform,
    git,
    node,
    nodeMajorMin: NODE_MAJOR_MIN,
    allSatisfied: git.present && nodeOk,
  };
}

/** AppleScript string-literal escaping (backslashes and double quotes only). */
function escapeForAppleScript(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

// Windows only: a well-known temp file install-windows.ps1 writes
// {"state":"running"|"done"|"error","message"?} to. Without this the GUI
// can't see past `cmd /c start` to know whether the detached PowerShell
// actually ran the install — it was reporting "Opened PowerShell and
// started the installer" even when the script never started (blocked by
// policy) or failed immediately (bad target dir). macOS/Linux don't have
// this yet: validation didn't find the same false-success gap there, and
// extending it unverified would be worse than leaving it alone — tracked
// as a follow-up, not silently assumed covered.
const INSTALL_STATUS_FILE = join(tmpdir(), "granted-install-status.json");
const STATUS_STARTED_TIMEOUT_MS = 10_000;
const STATUS_OVERALL_TIMEOUT_MS = 10 * 60_000;
const STATUS_POLL_INTERVAL_MS = 1_000;

// Guards the escape hatch end-to-end on Windows — set the instant a launch
// is attempted, cleared only once the real outcome is known (or given up
// on). Fixes a double-click starting two concurrent installers that raced
// against the same target directory: the old code re-enabled its button as
// soon as `spawn` resolved (tens of ms), not when the install finished.
let installInFlight = false;

async function readInstallStatus(): Promise<InstallStatusEvent | null> {
  try {
    const raw = await readFile(INSTALL_STATUS_FILE, "utf8");
    const parsed = JSON.parse(raw) as Partial<InstallStatusEvent>;
    if (parsed.state === "running" || parsed.state === "done" || parsed.state === "error") {
      return { state: parsed.state, message: parsed.message ?? null };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Polls INSTALL_STATUS_FILE until install-windows.ps1 reports "done"/"error",
 * or we give up — then sends exactly one `terminal:install-status` event to
 * the renderer and releases `installInFlight`. Never awaited by the IPC
 * handler: the install can take minutes (observed up to ~280s from a
 * pristine machine), far longer than it's reasonable to hold an
 * `ipcMain.handle` call open.
 */
function pollInstallStatus(sender: WebContents): void {
  const startedAt = Date.now();
  let sawRunning = false;

  // Closing the installer app mid-install is explicitly supported (the
  // PowerShell window must survive it), which means `sender` can become a
  // destroyed WebContents while this is still polling. send() on a
  // destroyed WebContents throws, so every send is guarded — there's no
  // one left to show the event to, but the poll must still stop cleanly
  // rather than surface an unhandled rejection from this timer.
  const safeSend = (status: InstallStatusEvent): void => {
    if (!sender.isDestroyed()) sender.send("terminal:install-status", status);
  };

  const timer = setInterval(() => {
    void (async (): Promise<void> => {
      const elapsed = Date.now() - startedAt;
      const status = await readInstallStatus();
      if (status?.state === "running") sawRunning = true;

      if (status?.state === "done" || status?.state === "error") {
        clearInterval(timer);
        installInFlight = false;
        safeSend(status);
        return;
      }

      if (!sawRunning && elapsed > STATUS_STARTED_TIMEOUT_MS) {
        clearInterval(timer);
        installInFlight = false;
        safeSend({
          state: "error",
          message:
            "Couldn't confirm the installer actually started — a security policy on this machine may have blocked it. Paste the command from your clipboard into PowerShell yourself to see the real error.",
        });
        return;
      }

      if (elapsed > STATUS_OVERALL_TIMEOUT_MS) {
        clearInterval(timer);
        installInFlight = false;
        safeSend({
          state: "error",
          message: "The installer is taking much longer than expected — check the PowerShell window directly.",
        });
      }
    })();
  }, STATUS_POLL_INTERVAL_MS);
}

async function openInstallTerminal(sender: WebContents): Promise<OpenInstallTerminalResult> {
  const platform = process.platform;

  if (!isSupportedPlatform(platform)) {
    return {
      ok: false,
      message: `Unsupported platform: ${platform}. Copy the install command manually from the README.`,
      command: "",
    };
  }

  if (installInFlight) {
    return {
      ok: false,
      message: "An install is already running in a terminal window — look for it before starting another.",
      command: INSTALL_ONE_LINERS[platform],
    };
  }

  const command = INSTALL_ONE_LINERS[platform];
  clipboard.writeText(command);

  try {
    if (platform === "darwin") {
      const script = escapeForAppleScript(command);
      await execFileAsync("osascript", [
        "-e",
        'tell application "Terminal" to activate',
        "-e",
        `tell application "Terminal" to do script "${script}"`,
      ]);
      return {
        ok: true,
        message: "Opened Terminal and started the installer. The command is also on your clipboard.",
        command,
      };
    }

    if (platform === "win32") {
      installInFlight = true;
      // Best-effort: clear any status file a previous run left behind, so a
      // stale "done"/"error" from last time can't be misread as this run's
      // outcome before install-windows.ps1 writes its own first update.
      await rm(INSTALL_STATUS_FILE, { force: true });

      // The one-liner must NOT appear on powershell.exe's command line:
      // Microsoft Defender's cloud ML flags `-Command "irm <url> | iex"` as
      // Trojan:Win32/Commando.A!ml and blocks/kills the process (seen on
      // Windows 11, regardless of the parent process's signature). The same
      // one-liner run from inside a script file is not flagged, so write it
      // verbatim to a temp .ps1 and run that. -File (unlike -Command) also
      // keeps the -NoExit window open when install-windows.ps1 calls `exit 1`,
      // so the user can actually read the error.
      //
      // One line is prepended ahead of the verbatim one-liner — it does NOT
      // touch what's copied to the clipboard (`command`, above, stays the
      // exact published one-liner) — telling install-windows.ps1 where to
      // report its real outcome, since this run's temp path differs from
      // its own default and must match what pollInstallStatus() reads.
      const scriptPath = join(tmpdir(), "granted-install.ps1");
      const scriptContents = `$env:GRANTED_STATUS_FILE = "${INSTALL_STATUS_FILE}"\r\n${command}\r\n`;
      await writeFile(scriptPath, scriptContents, "utf8");
      // Launched via `start` rather than spawning powershell.exe directly:
      // libuv implements `detached` with DETACHED_PROCESS, which gives a
      // console app no console window at all (PowerShell then runs invisibly
      // and -NoExit exits on stdin EOF), while a non-detached child is
      // killed when the installer closes. `start` gives it a real, new
      // console window that outlives us. /s + verbatim args so cmd takes
      // the quoted script path literally even if it contains spaces.
      const child = spawn(
        "cmd.exe",
        [
          "/d",
          "/s",
          "/c",
          `"start "" powershell.exe -NoExit -ExecutionPolicy Bypass -File "${scriptPath}""`,
        ],
        {
          // install-windows.ps1 clones into .\granted relative to its working
          // directory. Without this it inherits ours — the app's own folder
          // (or wherever it was launched from) — so start in the user's home
          // folder, same as a freshly opened PowerShell window would.
          cwd: homedir(),
          detached: true,
          stdio: "ignore",
          windowsHide: true,
          windowsVerbatimArguments: true,
        },
      );
      // spawn() reports launch failures (ENOENT, EPERM from AV, ...) via an
      // async 'error' event, not a throw — wait for it so the catch below
      // sees them instead of the main process crashing on an unhandled event.
      await new Promise<void>((resolveSpawn, rejectSpawn) => {
        child.once("spawn", resolveSpawn);
        child.once("error", rejectSpawn);
      });
      child.unref();
      pollInstallStatus(sender);
      const installDir = resolve(homedir(), process.env["GRANTED_INSTALL_DIR"] || "granted");
      return {
        ok: true,
        message: `Opened PowerShell and started the installer — Granted will be installed to ${installDir}. Watch that window; this screen will update on its own once it finishes. If it closes before then, paste the command from your clipboard into PowerShell.`,
        command,
      };
    }

    // linux: no uniform way to detect/launch a specific terminal emulator
    // across desktop environments. Clipboard + clear instructions is the
    // honest M1-scope answer rather than guessing at gnome-terminal/konsole/
    // xterm/etc.
    return {
      ok: true,
      message:
        "The install command has been copied to your clipboard. Open a terminal and paste it (Ctrl+Shift+V in most terminal emulators) to run it.",
      command,
    };
  } catch (err) {
    if (platform === "win32") installInFlight = false;
    // Logged for diagnostics, never shown to the user: raw Node/Windows
    // error text (e.g. "EBUSY: resource busy or locked, open '...'") means
    // nothing to Granted's non-technical audience — the actionable half
    // (the clipboard fallback) is what actually matters to them.
    console.error("openInstallTerminal failed:", err);
    return {
      ok: false,
      message: "Couldn't open a terminal automatically. The command is on your clipboard — paste it into a terminal and press Enter.",
      command,
    };
  }
}

export function registerIpcHandlers(): void {
  ipcMain.handle("prereqs:check", () => checkPrereqs());
  ipcMain.handle("terminal:open-install", (event) => openInstallTerminal(event.sender));
}
