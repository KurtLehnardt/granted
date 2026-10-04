import { clipboard, ipcMain } from "electron";
import type { WebContents } from "electron";
import { execFile, spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import {
  escapeForAppleScript,
  mergeRegistryPath,
  newInstallStatusPath,
  parseInstallStatusJson,
  parseVersionFromOutput,
  psSingleQuoted,
} from "./ipcPure";
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
 * in stdout (parseVersionFromOutput, in ./ipcPure). Missing binaries /
 * non-zero exits are reported as `present: false`, not thrown — a prereq
 * check must never crash the UI.
 */
async function checkVersionedTool(cmd: string, args: string[]): Promise<ToolCheckResult> {
  try {
    const { stdout } = await execFileAsync(cmd, args, { timeout: 5000, windowsHide: true });
    const { version, major } = parseVersionFromOutput(stdout);
    return { present: true, version, major };
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

// Windows only: the Electron process's PATH is a one-time snapshot taken at
// launch. install-windows.ps1 adds git/Node to the Machine/User PATH in the
// registry, which this long-lived process never re-reads on its own — a
// real install-windows-VM validation pass found this made the "Check
// again" button (and the auto-recheck on a real completion event) useless
// for the one scenario they exist for: both installed from scratch stayed
// reported as missing until the whole app was relaunched. Re-reading the
// registry (mirrors install-windows.ps1's own Sync-Path, which exists for
// the identical reason within that script) is the actual fix — not
// something a restart should be required for.
//
// Not extended to macOS/Linux: the same snapshot-staleness could plausibly
// exist there too (e.g. a Homebrew install in a separate Terminal, then
// "Check again" without relaunching the GUI), but that's unverified, not
// assumed safe — a follow-up, like the InstallStatusEvent scoping note
// below for the separate false-success gap.
// Fixed at module load, before anything can refresh/mutate process.env.PATH
// — the pristine baseline refreshWindowsPathEnv always rebuilds from below
// (see mergeRegistryPath, in ./ipcPure, for the actual merge/dedupe logic
// and its real-bug history).
const ORIGINAL_PATH = process.env["PATH"] ?? "";

async function refreshWindowsPathEnv(): Promise<void> {
  try {
    const { stdout } = await execFileAsync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "[Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')",
      ],
      { timeout: 5000, windowsHide: true },
    );
    const merged = mergeRegistryPath(ORIGINAL_PATH, stdout);
    if (merged !== null) process.env["PATH"] = merged;
  } catch (err) {
    // Best-effort: on failure, checks just run against whatever PATH the
    // process already had — the pre-fix behavior, not something worse.
    // Logged (not shown to the user, same as openInstallTerminal's catch)
    // so a silent failure here still leaves a trail instead of just
    // reading as "git/node genuinely missing" with no way to tell why.
    console.error("refreshWindowsPathEnv failed:", err);
  }
}

async function checkPrereqs(): Promise<PrereqReport> {
  const build = async (): Promise<PrereqReport> => {
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
  };

  let report = await build();
  // Only pay for a registry refresh (a powershell.exe spawn) when the
  // fast, unrefreshed check actually found something missing — covers
  // both "genuinely not installed" and "was just installed in a detached
  // process, but this already-running app's PATH snapshot hasn't caught
  // up" (see refreshWindowsPathEnv) without adding that cost to every
  // single check forever, including the common case (already-configured
  // machine) that can never need it.
  if (!report.allSatisfied && process.platform === "win32") {
    await refreshWindowsPathEnv();
    report = await build();
  }
  return report;
}

// Windows only: install-windows.ps1 writes
// {"state":"running"|"done"|"error","message"?} to a temp file unique to
// this one launch attempt (newInstallStatusPath, in ./ipcPure). Without
// this the GUI can't see past `cmd /c start` to know whether the detached
// PowerShell actually ran the install — it was reporting "Opened
// PowerShell and started the installer" even when the script never
// started (blocked by policy) or failed immediately (bad target dir).
// macOS/Linux don't have this yet: validation didn't find the same
// false-success gap there, and extending it unverified would be worse
// than leaving it alone — tracked as a follow-up, not silently assumed
// covered.
const STATUS_STARTED_TIMEOUT_MS = 10_000;
const STATUS_OVERALL_TIMEOUT_MS = 10 * 60_000;
const STATUS_POLL_INTERVAL_MS = 1_000;

// Guards the escape hatch end-to-end on Windows — set the instant a launch
// is attempted, cleared only once the real outcome is known (or given up
// on). Fixes a double-click starting two concurrent installers that raced
// against the same target directory: the old code re-enabled its button as
// soon as `spawn` resolved (tens of ms), not when the install finished.
let installInFlight = false;

async function readInstallStatus(statusPath: string): Promise<InstallStatusEvent | null> {
  try {
    const raw = await readFile(statusPath, "utf8");
    return parseInstallStatusJson(raw);
  } catch {
    return null;
  }
}

/**
 * Polls statusPath until install-windows.ps1 reports "done"/"error", or we
 * give up — then sends exactly one `terminal:install-status` event to the
 * renderer and releases `installInFlight`. Leaves the status file in place
 * (each attempt already has its own unique path, so there's nothing to
 * clean up for correctness, and it's a real diagnostic trail). Never
 * awaited by the IPC handler: the install can take minutes (observed up to
 * ~280s from a pristine machine), far longer than it's reasonable to hold
 * an `ipcMain.handle` call open.
 */
function pollInstallStatus(sender: WebContents, statusPath: string): void {
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

  // Deliberately leaves statusPath in place rather than deleting it here:
  // each attempt already gets a fresh, unique path (see
  // newInstallStatusPath), so there's no collision risk to clean up for —
  // and leaving it is a real diagnostic trail (what did the last install
  // actually report?) that an immediate delete would erase. A real-VM
  // validation pass also found that deleting it right after reading made
  // external verification of a "done" state racy for no benefit.
  const finish = (status: InstallStatusEvent): void => {
    installInFlight = false;
    safeSend(status);
  };

  const timer = setInterval(() => {
    void (async (): Promise<void> => {
      const elapsed = Date.now() - startedAt;
      const status = await readInstallStatus(statusPath);
      if (status?.state === "running") sawRunning = true;

      if (status?.state === "done" || status?.state === "error") {
        clearInterval(timer);
        finish(status);
        return;
      }

      if (!sawRunning && elapsed > STATUS_STARTED_TIMEOUT_MS) {
        clearInterval(timer);
        finish({
          state: "error",
          message:
            "Couldn't confirm the installer actually started — a security policy on this machine may have blocked it. Paste the command from your clipboard into PowerShell yourself to see the real error.",
        });
        return;
      }

      if (elapsed > STATUS_OVERALL_TIMEOUT_MS) {
        clearInterval(timer);
        finish({
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
      pollingStarted: false,
    };
  }

  if (installInFlight) {
    return {
      ok: false,
      message: "An install is already running in a terminal window — look for it before starting another.",
      command: INSTALL_ONE_LINERS[platform],
      pollingStarted: false,
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
        pollingStarted: false,
      };
    }

    if (platform === "win32") {
      installInFlight = true;
      const statusPath = newInstallStatusPath();

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
      // report its real outcome. Single-quoted so the path is taken
      // completely literally: a double-quoted PowerShell string would
      // expand a `$` or backtick if the path ever contained one.
      const scriptPath = join(tmpdir(), "granted-install.ps1");
      const scriptContents = `$env:GRANTED_STATUS_FILE = ${psSingleQuoted(statusPath)}\r\n${command}\r\n`;
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
      pollInstallStatus(sender, statusPath);
      const installDir = resolve(homedir(), process.env["GRANTED_INSTALL_DIR"] || "granted");
      return {
        ok: true,
        message: `Opened PowerShell and started the installer — Granted will be installed to ${installDir}. Watch that window; this screen will update on its own once it finishes. If it closes before then, paste the command from your clipboard into PowerShell.`,
        command,
        pollingStarted: true,
      };
    }

    // linux: no uniform way to detect/launch a specific terminal emulator
    // across desktop environments. Clipboard + clear instructions is the
    // honest M1-scope answer rather than guessing at gnome-terminal/konsole/
    // xterm/etc. A real validation pass confirmed the clipboard write
    // itself genuinely works (X11, verified byte-exact in both CLIPBOARD
    // and PRIMARY) -- but it's X11 selection ownership, not a system
    // clipboard history: closing this window before pasting can silently
    // lose it on a desktop with no clipboard manager running. Said
    // explicitly rather than assuming the user already knows that.
    return {
      ok: true,
      message:
        "The install command has been copied to your clipboard. Open a terminal and paste it (Ctrl+Shift+V in most terminal emulators) to run it — do this before closing this window, since some Linux desktops clear the clipboard once the app that copied it exits.",
      command,
      pollingStarted: false,
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
      pollingStarted: false,
    };
  }
}

export function registerIpcHandlers(): void {
  ipcMain.handle("prereqs:check", () => checkPrereqs());
  ipcMain.handle("terminal:open-install", (event) => openInstallTerminal(event.sender));
}
