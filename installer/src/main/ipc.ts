import { BrowserWindow, clipboard, ipcMain, shell } from "electron";
import type { WebContents } from "electron";
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import {
  buildTaskScript,
  escapeForAppleScript,
  grantedPort,
  mergeRegistryPath,
  newInstallStatusPath,
  newTaskStatusPath,
  parseVersionFromOutput,
  psSingleQuoted,
} from "./ipcPure";
import { getSetupState, probeGranted, readStatusFile, saveApiKeys, waitForGrantedToStart } from "./openGranted";
import {
  INSTALL_ONE_LINERS,
  NODE_MAJOR_MIN,
  type ActionResult,
  type ApiKeysInput,
  type InstallStatusEvent,
  type OpenInstallTerminalResult,
  type PrereqReport,
  type TaskStatusEvent,
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
  // Closing the installer app mid-install is explicitly supported (the
  // PowerShell window must survive it), which means `sender` can become a
  // destroyed WebContents while this is still polling. send() on a
  // destroyed WebContents throws, so every send is guarded — there's no
  // one left to show the event to, but the poll must still stop cleanly
  // rather than surface an unhandled rejection from this timer.
  //
  // Deliberately leaves statusPath in place rather than deleting it here:
  // each attempt already gets a fresh, unique path (see
  // newInstallStatusPath), so there's no collision risk to clean up for —
  // and leaving it is a real diagnostic trail (what did the last install
  // actually report?) that an immediate delete would erase. A real-VM
  // validation pass also found that deleting it right after reading made
  // external verification of a "done" state racy for no benefit.
  pollStatusFile(
    statusPath,
    {
      startedTimeoutMs: STATUS_STARTED_TIMEOUT_MS,
      overallTimeoutMs: STATUS_OVERALL_TIMEOUT_MS,
      notStartedMessage:
        "Couldn't confirm the installer actually started — a security policy on this machine may have blocked it. Paste the command from your clipboard into PowerShell yourself to see the real error.",
      timedOutMessage: "The installer is taking much longer than expected — check the PowerShell window directly.",
    },
    (status) => {
      installInFlight = false;
      if (!sender.isDestroyed()) sender.send("terminal:install-status", status);
    },
  );
}

interface StatusPollOptions {
  startedTimeoutMs: number;
  overallTimeoutMs: number;
  notStartedMessage: string;
  timedOutMessage: string;
}

/**
 * Polls a status file (install-windows.ps1's, or a buildTaskScript one)
 * until it reports "done"/"error", never reports "running" within
 * startedTimeoutMs, or overallTimeoutMs passes — then calls onFinish
 * exactly once.
 */
function pollStatusFile(
  statusPath: string,
  opts: StatusPollOptions,
  onFinish: (status: InstallStatusEvent) => void,
): void {
  const startedAt = Date.now();
  let sawRunning = false;

  const timer = setInterval(() => {
    void (async (): Promise<void> => {
      const elapsed = Date.now() - startedAt;
      const status = await readStatusFile(statusPath);
      if (status?.state === "running") sawRunning = true;

      if (status?.state === "done" || status?.state === "error") {
        clearInterval(timer);
        onFinish(status);
        return;
      }

      if (!sawRunning && elapsed > opts.startedTimeoutMs) {
        clearInterval(timer);
        onFinish({ state: "error", message: opts.notStartedMessage });
        return;
      }

      if (elapsed > opts.overallTimeoutMs) {
        clearInterval(timer);
        onFinish({ state: "error", message: opts.timedOutMessage });
      }
    })();
  }, STATUS_POLL_INTERVAL_MS);
}

/**
 * Runs a .ps1 in a new, visible PowerShell console window that outlives this
 * app. Launched via `start` rather than spawning powershell.exe directly:
 * libuv implements `detached` with DETACHED_PROCESS, which gives a console
 * app no console window at all (PowerShell then runs invisibly and -NoExit
 * exits on stdin EOF), while a non-detached child is killed when the
 * installer closes. `start` gives it a real, new console window that
 * outlives us. /s + verbatim args so cmd takes the quoted script path
 * literally even if it contains spaces. Resolves once the window process
 * exists; rejects on a launch failure (ENOENT, EPERM from AV, ...), which
 * spawn() reports via an async 'error' event rather than a throw.
 */
async function launchConsoleWindow(scriptPath: string, cwd: string): Promise<void> {
  const child = spawn(
    "cmd.exe",
    ["/d", "/s", "/c", `"start "" powershell.exe -NoExit -ExecutionPolicy Bypass -File "${scriptPath}""`],
    {
      cwd,
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      windowsVerbatimArguments: true,
    },
  );
  await new Promise<void>((resolveSpawn, rejectSpawn) => {
    child.once("spawn", resolveSpawn);
    child.once("error", rejectSpawn);
  });
  child.unref();
}

/** install-windows.ps1's $TargetDir, resolved the same way: relative to the home folder it's launched from. */
function installDir(): string {
  return resolve(homedir(), process.env["GRANTED_INSTALL_DIR"] || "granted");
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
      // install-windows.ps1 clones into .\granted relative to its working
      // directory. Without an explicit cwd it inherits ours — the app's own
      // folder (or wherever it was launched from) — so start in the user's
      // home folder, same as a freshly opened PowerShell window would. A
      // launch failure rejects here, so the catch below sees it instead of
      // the main process crashing on an unhandled 'error' event.
      await launchConsoleWindow(scriptPath, homedir());
      pollInstallStatus(sender, statusPath);
      return {
        ok: true,
        message: `Opened PowerShell and started the installer — Granted will be installed to ${installDir()}. Watch that window; this screen will update on its own once it finishes. If it closes before then, paste the command from your clipboard into PowerShell.`,
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

// ---------------------------------------------------------------------------
// "Open Granted" — after a successful install, do the README's next steps
// for the user: configure .env.local (their API keys, or the fully-local
// Ollama setup), start `npm run dev`, and open the browser once it answers.
// Windows only, like the install-status reporting it follows on from: it's
// the only platform whose install reports completion, so it's the only one
// that ever reaches this screen. The file/network logic lives in
// ./openGranted (Electron-free, so it's testable); this is the glue.
// ---------------------------------------------------------------------------

const GRANTED_PORT = grantedPort(process.env["GRANTED_PORT"]);
const GRANTED_URL = `http://localhost:${GRANTED_PORT}`;
// `npm run dev` binds 127.0.0.1 specifically (`next dev -H 127.0.0.1`), so
// probe that rather than "localhost", which can resolve to ::1 first.
const GRANTED_PROBE_URL = `http://127.0.0.1:${GRANTED_PORT}/`;
const LOCAL_SETUP_TIMEOUT_MS = 2 * 60 * 60_000; // model pull + corpus re-embed: "a few minutes to a half hour", more on slow links
const APP_START_TIMEOUT_MS = 5 * 60_000; // first `next dev` compile of the home page
const PROBE_TIMEOUT_MS = 60_000;
const NOT_WINDOWS: ActionResult = {
  ok: false,
  message: "Opening Granted from the installer is only available on Windows so far.",
};

// One "Open Granted" step at a time — same reasoning as installInFlight.
let grantedTaskInFlight = false;

function scaffoldDir(): string {
  return join(installDir(), "scaffold");
}

/** Writes a buildTaskScript .ps1 and runs it in its own console window in scaffold/. */
async function launchScaffoldTask(opts: {
  task: string;
  title: string;
  command: string;
  failureMessage: string;
  env?: Record<string, string>;
}): Promise<string> {
  // git/Node were installed by a detached process after this app started,
  // so refresh PATH from the registry before the window inherits it.
  await refreshWindowsPathEnv();
  const statusPath = newTaskStatusPath(opts.task);
  const scriptPath = join(tmpdir(), `granted-${opts.task}-${randomUUID()}.ps1`);
  await writeFile(
    scriptPath,
    buildTaskScript({
      title: opts.title,
      cwd: scaffoldDir(),
      statusPath,
      command: opts.command,
      failureMessage: opts.failureMessage,
      env: opts.env,
    }),
    "utf8",
  );
  await launchConsoleWindow(scriptPath, scaffoldDir());
  return statusPath;
}

function sendTaskStatus(sender: WebContents, status: TaskStatusEvent): void {
  if (!sender.isDestroyed()) sender.send("granted:task-status", status);
}

async function runLocalSetup(sender: WebContents): Promise<ActionResult> {
  if (process.platform !== "win32") return NOT_WINDOWS;
  if (grantedTaskInFlight) return { ok: false, message: "Granted's setup is already running in another window." };
  grantedTaskInFlight = true;
  try {
    // --yes: unattended defaults (recommended model for this machine's
    // memory, plus the corpus re-embed) — the wizard has already asked the
    // one question that matters.
    const statusPath = await launchScaffoldTask({
      task: "local-setup",
      title: "Granted - local setup (Ollama)",
      command: "npm.cmd run setup:local -- --yes",
      failureMessage: "The local setup didn't finish. The error is shown above in this window.",
    });
    pollStatusFile(
      statusPath,
      {
        startedTimeoutMs: STATUS_STARTED_TIMEOUT_MS,
        overallTimeoutMs: LOCAL_SETUP_TIMEOUT_MS,
        notStartedMessage: "Couldn't confirm the local setup started — check whether a PowerShell window opened.",
        timedOutMessage: "The local setup is taking much longer than expected — check its PowerShell window.",
      },
      (status) => {
        grantedTaskInFlight = false;
        sendTaskStatus(sender, {
          task: "local-setup",
          state: status.state === "done" ? "done" : "error",
          message: status.state === "done" ? null : (status.message ?? "The local setup didn't finish."),
        });
      },
    );
    return { ok: true, message: "Started the local setup in a PowerShell window." };
  } catch (err) {
    grantedTaskInFlight = false;
    console.error("runLocalSetup failed:", err);
    return { ok: false, message: "Couldn't open a PowerShell window for the local setup." };
  }
}

async function startGranted(sender: WebContents): Promise<ActionResult> {
  if (process.platform !== "win32") return NOT_WINDOWS;
  if (grantedTaskInFlight) return { ok: false, message: "Granted is already being set up or started." };
  grantedTaskInFlight = true;

  const finish = (state: "done" | "error", message: string | null): void => {
    grantedTaskInFlight = false;
    sendTaskStatus(sender, { task: "start-app", state, message, url: GRANTED_URL });
  };

  try {
    // Already running (e.g. "Open Granted" clicked a second time) — don't
    // start a second server, which `next dev` would quietly put on 3001.
    const before = await probeGranted(GRANTED_PROBE_URL, 3000);
    if (before === "granted") {
      await shell.openExternal(GRANTED_URL);
      finish("done", "Granted was already running — opened it in your browser.");
      return { ok: true, message: "Granted is already running." };
    }
    if (before === "other") {
      grantedTaskInFlight = false;
      return {
        ok: false,
        message: `Another program is already using port ${GRANTED_PORT}, so Granted can't start there. Close it and try again.`,
      };
    }

    const statusPath = await launchScaffoldTask({
      task: "start-app",
      title: "Granted - keep this window open while you use Granted",
      command: "npm.cmd run dev",
      failureMessage: "Granted stopped. The error is shown above in this window.",
      // Next.js reads PORT; set it explicitly so the server is always where
      // the probe below looks, whatever PORT the user's environment has.
      env: { PORT: String(GRANTED_PORT) },
    });

    void waitForGrantedToStart({
      probe: () => probeGranted(GRANTED_PROBE_URL, PROBE_TIMEOUT_MS),
      readStatus: () => readStatusFile(statusPath),
      timeoutMs: APP_START_TIMEOUT_MS,
      intervalMs: 2000,
    }).then(async (outcome) => {
      if (outcome.ok) {
        await shell.openExternal(GRANTED_URL);
        finish("done", null);
      } else if (outcome.reason === "exited") {
        finish("error", "Granted stopped before it finished starting — the error is in its PowerShell window.");
      } else {
        finish("error", `Granted didn't answer within ${APP_START_TIMEOUT_MS / 60_000} minutes — check its PowerShell window.`);
      }
    });
    return { ok: true, message: "Starting Granted…" };
  } catch (err) {
    grantedTaskInFlight = false;
    console.error("startGranted failed:", err);
    return { ok: false, message: "Couldn't open a PowerShell window to start Granted." };
  }
}

export function registerIpcHandlers(): void {
  ipcMain.handle("prereqs:check", () => checkPrereqs());
  ipcMain.handle("terminal:open-install", (event) => openInstallTerminal(event.sender));
  ipcMain.handle("granted:get-setup-state", () => getSetupState(installDir()));
  ipcMain.handle("granted:save-api-keys", (_event, keys: ApiKeysInput) => saveApiKeys(scaffoldDir(), keys));
  ipcMain.handle("granted:run-local-setup", (event) => runLocalSetup(event.sender));
  ipcMain.handle("granted:start", (event) => startGranted(event.sender));
  ipcMain.on("app:quit", (event) => BrowserWindow.fromWebContents(event.sender)?.close());
}
