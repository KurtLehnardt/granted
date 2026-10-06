import { BrowserWindow, clipboard, ipcMain, shell } from "electron";
import type { WebContents } from "electron";
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, openSync, rmdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import {
  buildMacInstallScript,
  buildTaskScript,
  decideStatusPoll,
  escapeForAppleScript,
  grantedPort,
  grantedSettingsPath,
  macStatusLockPath,
  mergeRegistryPath,
  newInstallStatusPath,
  newTaskStatusPath,
  parseOpenGrantedOutput,
  parseShortcutsOutput,
  parseVersionFromOutput,
  buildWindowsInstallScript,
  psSingleQuoted,
  shSingleQuoted,
  windowsInstallCommand,
  shouldReattach,
  startProcessCommand,
  trayLaunchCommand,
  type StatusFile,
} from "./ipcPure";
import {
  getSetupState,
  probeGranted,
  readTaskStatus,
  saveApiKeys,
  saveOpenIn,
  waitForGrantedToStart,
  windowsScriptPath,
} from "./openGranted";
import { createVersionPlanner, LATEST_RELEASE_API, pinnedReleaseTag } from "./release";
import {
  INSTALL_ONE_LINERS,
  NODE_MAJOR_MIN,
  type ActionResult,
  type ApiKeysInput,
  type InstallStatusEvent,
  type OpenIn,
  type OpenInstallTerminalResult,
  type PrereqReport,
  type ShortcutChoice,
  type ShortcutsResult,
  type StartResult,
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
// For the install, past this a still-open window is NOT given up on — the
// user gets a one-off "still waiting" notice instead (see decideStatusPoll).
// It's only a hard limit for a status file with no pid (an older
// install-windows.ps1), where liveness can't be checked.
const STATUS_OVERALL_TIMEOUT_MS = 10 * 60_000;
const STATUS_POLL_INTERVAL_MS = 1_000;
// How recently an attempt that hasn't reported anything yet counts as
// "still starting" (re-attach to it) rather than "never started" (launch anew).
const RECENT_LAUNCH_MS = 60_000;

// Guards the escape hatch end-to-end on Windows — set the instant a launch
// is attempted, cleared only once the real outcome is known (or given up
// on). Fixes a double-click starting two concurrent installers that raced
// against the same target directory: the old code re-enabled its button as
// soon as `spawn` resolved (tens of ms), not when the install finished.
let installInFlight = false;

// Platform-worded (win32's PowerShell/UAC/taskbar text makes no sense on
// macOS's Terminal, and the closed-window one especially is not a rare
// edge case there — a mac user closing Terminal mid-install is completely
// ordinary). Same ternary-at-the-point-of-use pattern as runLocalSetup/
// startGranted below.
const INSTALL_WINDOW_CLOSED_MESSAGE =
  process.platform === "win32"
    ? "The installer's PowerShell window was closed before it finished. Click the button below to start it again."
    : "The installer's Terminal window was closed before it finished. Click the button below to start it again.";
const INSTALL_STILL_WAITING_MESSAGE =
  process.platform === "win32"
    ? "The installer is still running in its PowerShell window. If it's waiting for you — a Windows permission (UAC) prompt, which may be behind other windows or flashing in the taskbar — answer it. If it's stuck, close that window to cancel."
    : "The installer is still running in its Terminal window. If it's waiting for you — a permission prompt, which may be behind other windows — answer it. If it's stuck, close that window to cancel.";

/** Every console window this app launches that reports through a status file. */
type WindowTask = "install" | "local-setup" | "start-app";

// The most recent attempt for each task. If a poll gave up on one (e.g. no
// "running" within STATUS_STARTED_TIMEOUT_MS on a slow, AV-heavy machine)
// but its window turns out to be alive after all — or it finished — the
// next click re-attaches to it (shouldReattach) instead of starting a
// second, concurrent copy.
const lastAttempt: Partial<Record<WindowTask, { statusPath: string; launchedAt: number }>> = {};

function rememberLaunch(task: WindowTask, statusPath: string): void {
  lastAttempt[task] = { statusPath, launchedAt: Date.now() };
}

/** The previous attempt's status file, if a click should re-attach to it rather than launch anew. */
async function reattachablePath(task: WindowTask, acceptDone: boolean): Promise<string | null> {
  const attempt = lastAttempt[task];
  if (!attempt) return null;
  const status = await readTaskStatus(attempt.statusPath);
  const reattach = shouldReattach(status, {
    launchedMsAgo: Date.now() - attempt.launchedAt,
    recentLaunchMs: RECENT_LAUNCH_MS,
    acceptDone,
  });
  return reattach ? attempt.statusPath : null;
}

/**
 * Polls statusPath until install-windows.ps1 reports "done"/"error", its
 * window is closed, or it never starts — then sends exactly one final
 * `terminal:install-status` event to the renderer and releases
 * `installInFlight`. (Past STATUS_OVERALL_TIMEOUT_MS it also sends one
 * non-final "running" notice, but keeps waiting while the window is open.)
 * Leaves the status file in place (each attempt already has its own unique
 * path, so there's nothing to clean up for correctness, and it's a real
 * diagnostic trail). Never awaited by the IPC handler: the install can take
 * minutes (observed up to ~280s from a pristine machine, far longer while a
 * UAC prompt waits), far longer than it's reasonable to hold an
 * `ipcMain.handle` call open.
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
  const send = (status: InstallStatusEvent): void => {
    if (!sender.isDestroyed()) sender.send("terminal:install-status", status);
  };
  pollStatusFile(
    statusPath,
    {
      startedTimeoutMs: STATUS_STARTED_TIMEOUT_MS,
      overallTimeoutMs: STATUS_OVERALL_TIMEOUT_MS,
      notStartedMessage:
        process.platform === "win32"
          ? "Couldn't confirm the installer actually started — a security policy on this machine may have blocked it. Paste the command from your clipboard into PowerShell yourself to see the real error."
          : "Couldn't confirm the installer actually started — a security policy on this machine may have blocked it. Paste the command from your clipboard into Terminal yourself to see the real error.",
      timedOutMessage:
        process.platform === "win32"
          ? "The installer is taking much longer than expected — check the PowerShell window directly."
          : "The installer is taking much longer than expected — check the Terminal window directly.",
      closedMessage: INSTALL_WINDOW_CLOSED_MESSAGE,
      waitWhileAlive: true,
      onStillWaiting: () => send({ state: "running", message: INSTALL_STILL_WAITING_MESSAGE }),
    },
    (status) => {
      installInFlight = false;
      send(status);
    },
  );
}

interface StatusPollOptions {
  startedTimeoutMs: number;
  overallTimeoutMs: number;
  notStartedMessage: string;
  timedOutMessage: string;
  /** Used instead of the generic text when the window was closed mid-run. */
  closedMessage?: string;
  /** Keep waiting past overallTimeoutMs while the window is alive (see decideStatusPoll). */
  waitWhileAlive?: boolean;
  /** Called once when waitWhileAlive keeps a poll going past overallTimeoutMs. */
  onStillWaiting?: () => void;
}

/**
 * Polls a status file (install-windows.ps1's, or a buildTaskScript one) —
 * through readTaskStatus, so a window that was closed mid-run reads as an
 * error at once — until decideStatusPoll says it's finished, then calls
 * onFinish exactly once. A tick is skipped while the previous one's read is
 * still in flight (a slow read under AV/disk contention can outlast the
 * interval), so two ticks can never both see "done" and finish twice.
 */
function pollStatusFile(
  statusPath: string,
  opts: StatusPollOptions,
  onFinish: (status: InstallStatusEvent) => void,
): void {
  const startedAt = Date.now();
  let sawRunning = false;
  let reading = false;
  let finished = false;
  let notifiedStillWaiting = false;

  const finish = (status: InstallStatusEvent): void => {
    if (finished) return;
    finished = true;
    clearInterval(timer);
    onFinish(status);
  };

  const timer = setInterval(() => {
    if (reading || finished) return;
    reading = true;
    void (async (): Promise<void> => {
      try {
        const status = await readTaskStatus(statusPath);
        if (status?.state === "running") sawRunning = true;
        const decision = decideStatusPoll({ ...opts, status, elapsedMs: Date.now() - startedAt, sawRunning });
        if (decision && "finish" in decision) {
          finish(decision.finish);
        } else if (decision && !notifiedStillWaiting) {
          notifiedStillWaiting = true;
          opts.onStillWaiting?.();
        }
      } finally {
        reading = false;
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

// Which Granted to install (src/main/release.ts). GRANTED_RELEASES_API:
// tests point the update check at a local server.
// Windows only: the macOS/Linux one-liners always install main, so a pinned
// release (and the update check) would only be a misleading note there.
const versionPlanner = createVersionPlanner({
  pinned: process.platform === "win32" ? pinnedReleaseTag() : null,
  latestUrl: process.env["GRANTED_RELEASES_API"] || LATEST_RELEASE_API,
});

async function openInstallTerminal(sender: WebContents, checkForUpdates: boolean): Promise<OpenInstallTerminalResult> {
  const platform = process.platform;

  if (!isSupportedPlatform(platform)) {
    return {
      ok: false,
      message: `Unsupported platform: ${platform}. Copy the install command manually from the README.`,
      command: "",
      pollingStarted: false,
    };
  }

  // Windows installs the release the screen showed (this installer's own, or
  // a newer one if the user asked to check) -- decided from what the screen
  // already learned, with no new request to GitHub, so it's exactly what the
  // note said, and nothing is awaited between the in-flight check below and
  // claiming it. The macOS/Linux scripts install main.
  const plan = platform === "win32" ? versionPlanner.current(checkForUpdates) : null;
  const command = plan ? windowsInstallCommand(plan.ref) : INSTALL_ONE_LINERS[platform];

  if (installInFlight) {
    return {
      ok: false,
      message: "An install is already running in a terminal window — look for it before starting another.",
      command,
      pollingStarted: false,
    };
  }

  clipboard.writeText(command);

  try {
    if (platform === "darwin") {
      installInFlight = true;

      // Mirrors the win32 branch just below: an earlier attempt the poll
      // gave up on, whose Terminal window is in fact still running (or
      // still starting, or has since finished), is watched again rather
      // than launching a second install.
      const previous = await reattachablePath("install", true);
      if (previous) {
        pollInstallStatus(sender, previous);
        return {
          ok: true,
          message:
            "The installer from before is still running in its Terminal window — this screen will update on its own once it finishes.",
          command,
          pollingStarted: true,
        };
      }

      const statusPath = newInstallStatusPath();
      // Written to a temp file and run from there, never put directly on
      // osascript's command line — same reasoning as Windows's temp .ps1
      // (see the win32 branch below): a multi-line script embedded in an
      // AppleScript string literal is exactly the kind of thing that's
      // fragile to get right character-for-character, every time, versus
      // writing it once to disk and asking Terminal to run that file.
      const scriptPath = join(tmpdir(), `granted-install-${randomUUID()}.sh`);
      await writeFile(scriptPath, buildMacInstallScript(statusPath, plan?.ref ?? null), "utf8");
      rememberLaunch("install", statusPath);
      // Only the short "run this file" command needs AppleScript's own
      // string-literal escaping (`\`/`"`) — the actual install logic lives
      // in the file, untouched by it. `cd` first: install-macos.sh clones
      // into ./granted relative to its working directory, and a `do
      // script` window's default directory isn't guaranteed to be the
      // user's home folder (it follows Terminal's own "new windows open
      // with" preference) — explicit, same reason win32's launchConsoleWindow
      // is given homedir() rather than inheriting whatever this app's own
      // cwd happens to be.
      const doScript = escapeForAppleScript(`cd ${shSingleQuoted(homedir())} && bash ${shSingleQuoted(scriptPath)}`);
      await execFileAsync("osascript", [
        "-e",
        'tell application "Terminal" to activate',
        "-e",
        `tell application "Terminal" to do script "${doScript}"`,
      ]);
      pollInstallStatus(sender, statusPath);
      return {
        ok: true,
        message: `Opened Terminal and started the installer — Granted${plan?.ref ? ` ${plan.ref}` : ""} will be installed to ${installDir()}. Watch that window; this screen will update on its own once it finishes. If it closes before then, paste the command from your clipboard into Terminal.`,
        command,
        pollingStarted: true,
      };
    }

    if (platform === "win32") {
      installInFlight = true;

      // An earlier attempt the poll gave up on whose window is in fact still
      // running (or still starting, or that has since finished): watch that
      // one again rather than launching a second install into the same
      // folder. A finished one is then reported straight away.
      const previous = await reattachablePath("install", true);
      if (previous) {
        pollInstallStatus(sender, previous);
        return {
          ok: true,
          message:
            "The installer from before is still running in its PowerShell window — this screen will update on its own once it finishes.",
          command,
          pollingStarted: true,
        };
      }

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
      //
      // A unique file per attempt (not one fixed name): a window that's slow
      // to start reads its script late, and a fixed path could by then hold
      // a LATER attempt's status path — two windows reporting into one file.
      const scriptPath = join(tmpdir(), `granted-install-${randomUUID()}.ps1`);
      await writeFile(scriptPath, buildWindowsInstallScript(statusPath, plan?.ref ?? null), "utf8");
      rememberLaunch("install", statusPath);
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
        message: `Opened PowerShell and started the installer — Granted${plan?.ref ? ` ${plan.ref}` : ""} will be installed to ${installDir()}. Watch that window; this screen will update on its own once it finishes. If it closes before then, paste the command from your clipboard into PowerShell.`,
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
    if (platform === "win32" || platform === "darwin") installInFlight = false;
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
// Long enough that a Granted busy compiling its first request reads as
// "busy" rather than "down" — "down" starts a second server.
const ALREADY_RUNNING_PROBE_TIMEOUT_MS = 10_000;
// Named for what it originally gated (Windows-only); now also allows
// darwin, so this fires only for linux (createShortcuts below stays
// win32-only — a later, separate piece of work, not touched by this).
const NOT_WINDOWS: ActionResult = {
  ok: false,
  message: "Opening Granted from the installer is only available on Windows and macOS so far.",
};

type GrantedTask = Exclude<WindowTask, "install">;

// One "Open Granted" step at a time — same reasoning as installInFlight.
let grantedTaskInFlight = false;

function scaffoldDir(): string {
  return join(installDir(), "scaffold");
}

function settingsPath(): string {
  return grantedSettingsPath(process.env, homedir());
}

/** Writes a buildTaskScript .ps1 and runs it in its own console window in scaffold/. */
async function launchScaffoldTask(opts: {
  task: GrantedTask;
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
  rememberLaunch(opts.task, statusPath);
  await launchConsoleWindow(scriptPath, scaffoldDir());
  return statusPath;
}

/**
 * macOS, for now: a minimal, first-cut path, deliberately smaller than
 * Windows's — no visible console window (there's nothing here yet that
 * needs one kept open the way launchScaffoldTask's does), no tray, no own
 * app window (those are separate, later work). getSetupState's
 * trayAvailable/shortcutsAvailable/appWindowAvailable stay false on darwin
 * because they're explicitly gated on process.platform === "win32" — NOT
 * because this install lacks scripts/windows: those .ps1 files are ordinary
 * files tracked in the repo, so a real `git clone` on macOS has them too,
 * the same as on Windows. `command` is spawned directly, detached so it
 * outlives the installer the same way
 * Windows's console window does, writing the exact same {state,message,pid}
 * status-file shape buildTaskScript's PowerShell writes — so it's read back
 * by the SAME readTaskStatus/pollStatusFile/decideStatusPoll Windows uses,
 * completely unchanged. There's no window to show output in, so stdout/
 * stderr go to a log file instead, named only in a failure's message.
 *
 * Also takes the same `<status>.lock.d` directory lock install-macos.sh
 * does (see macStatusLockPath and openGranted.ts's isStatusWindowAlive):
 * without it, "is this still running" would have nothing to go on besides a
 * bare pid, which isStatusWindowAlive's non-win32 branch deliberately
 * doesn't lean on alone (a pid can be reused by an unrelated process).
 */
async function launchMacScaffoldTask(opts: {
  task: GrantedTask;
  command: string;
  args: string[];
  failureMessage: string;
  env?: Record<string, string>;
}): Promise<string> {
  const statusPath = newTaskStatusPath(opts.task);
  const lockDir = macStatusLockPath(statusPath);
  const logPath = join(tmpdir(), `granted-${opts.task}-${randomUUID()}.log`);
  const writeStatus = (status: StatusFile): Promise<void> =>
    writeFile(statusPath, JSON.stringify(status), "utf8").catch((err) => console.error("writeStatus failed:", err));
  const removeLock = (): void => {
    try {
      rmdirSync(lockDir);
    } catch {
      // Already gone, or never created — best effort either way.
    }
  };
  try {
    mkdirSync(lockDir);
  } catch {
    // Best effort, same as install-macos.sh's own `mkdir ... || true`.
  }
  let child: ReturnType<typeof spawn>;
  try {
    const log = openSync(logPath, "a");
    child = spawn(opts.command, opts.args, {
      cwd: scaffoldDir(),
      detached: true,
      stdio: ["ignore", log, log],
      env: { ...process.env, ...opts.env },
    });
  } catch (err) {
    // A synchronous spawn failure (rare — spawn() normally reports even
    // ENOENT asynchronously via 'error' below): nothing is running, so the
    // lock must not outlive it either.
    removeLock();
    throw err;
  }
  const withPid = (status: Omit<StatusFile, "pid">): StatusFile => (child.pid !== undefined ? { ...status, pid: child.pid } : status);
  // Registered immediately, before any `await` below: spawn()'s own
  // failure (ENOENT, if `opts.command` isn't on PATH — a real risk here,
  // see the PATH-snapshot comment above) reports via an 'error' event fired
  // from process.nextTick, which drains BEFORE this function would resume
  // after an `await` — registering after one, as an earlier version of
  // this function did, missed it entirely: zero listeners were attached
  // yet, so the error threw uncaught in the main process. Same hazard,
  // same fix as launchConsoleWindow's own comment above.
  child.once("exit", async (code) => {
    // The status write first, lock removal after: openGranted.ts's
    // isStatusWindowAlive treats a gone lock directory as "this side
    // already wrote its final status" — removing it first would let a
    // poll tick land in between and read a stale "running" status with no
    // lock, wrongly reporting a run that's actually about to succeed as
    // having "ended unexpectedly before it finished."
    await writeStatus(
      withPid(
        code === 0
          ? { state: "done", message: null }
          : { state: "error", message: `${opts.failureMessage} See ${logPath} for details.` },
      ),
    );
    removeLock();
  });
  child.once("error", async (err) => {
    await writeStatus(withPid({ state: "error", message: `${opts.failureMessage} (${err.message})` }));
    removeLock();
  });
  child.unref();
  rememberLaunch(opts.task, statusPath);
  await writeStatus(withPid({ state: "running", message: null }));
  return statusPath;
}

function sendTaskStatus(sender: WebContents, status: TaskStatusEvent): void {
  if (!sender.isDestroyed()) sender.send("granted:task-status", status);
}

/** shell.openExternal, reporting failure (no default browser, policy, …) instead of throwing. */
async function openInBrowser(url: string): Promise<boolean> {
  try {
    await shell.openExternal(url);
    return true;
  } catch (err) {
    console.error("openExternal failed:", err);
    return false;
  }
}

/**
 * Opens Granted the way the user prefers: in its own window (Edge/Chrome app
 * mode, via scripts/windows/open-granted.ps1 — the same script the tray and
 * shortcuts use) or a browser tab. The browser-tab part stays here
 * (shell.openExternal), so an install without the script, a machine with no
 * app-mode browser, or a script that failed all still open Granted.
 * Returns how it opened, or null if nothing could be opened — including when
 * the script timed out: it may already have started the window, and a tab on
 * top of that would open Granted twice (the caller then shows the URL).
 */
async function openGrantedPage(url: string): Promise<OpenIn | null> {
  const script = windowsScriptPath(scaffoldDir(), "open-granted.ps1");
  // win32-gated, not just existsSync: open-granted.ps1 is an ordinary file
  // tracked in the repo, present on a real clone on every platform, not
  // only Windows's — without this guard this would spawn powershell.exe on
  // macOS too (nonexistent there; ENOENT is caught below so this doesn't
  // crash, but it's a wasted spawn and a spurious logged error on every
  // "Open Granted" click, and inconsistent with the guard this PR already
  // added at every other scripts/windows call site).
  if (process.platform === "win32" && existsSync(script)) {
    try {
      const { stdout } = await execFileAsync(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, "-Url", url, "-NoBrowserFallback"],
        { windowsHide: true, timeout: 30_000 },
      );
      const opened = parseOpenGrantedOutput(stdout);
      if (opened === "window") return "window";
      // Unreadable output after a clean exit: it may have launched the window — don't risk a second one.
      if (opened !== "none") return null;
    } catch (err) {
      console.error("open-granted.ps1 failed:", err);
      if ((err as { killed?: boolean }).killed) return null;
      // Otherwise it failed before launching anything (e.g. PowerShell couldn't run it): a tab it is.
    }
  }
  return (await openInBrowser(url)) ? "browser" : null;
}

async function runLocalSetup(sender: WebContents): Promise<ActionResult> {
  if (process.platform !== "win32" && process.platform !== "darwin") return NOT_WINDOWS;
  if (grantedTaskInFlight) return { ok: false, message: "Granted's setup is already running in another window." };
  grantedTaskInFlight = true;
  try {
    // --yes: unattended defaults (recommended model for this machine's
    // memory, plus the corpus re-embed) — the wizard has already asked the
    // one question that matters.
    const statusPath =
      // A finished ("done") earlier attempt counts too: the poll below then
      // reports it at once and Granted starts, instead of redoing a
      // half-hour model pull and re-embed.
      (await reattachablePath("local-setup", true)) ??
      (process.platform === "win32"
        ? await launchScaffoldTask({
            task: "local-setup",
            title: "Granted - local setup (Ollama)",
            command: "npm.cmd run setup:local -- --yes",
            failureMessage: "The local setup didn't finish. The error is shown above in this window.",
          })
        : await launchMacScaffoldTask({
            task: "local-setup",
            command: "npm",
            args: ["run", "setup:local", "--", "--yes"],
            failureMessage: "The local setup didn't finish.",
          }));
    pollStatusFile(
      statusPath,
      process.platform === "win32"
        ? {
            startedTimeoutMs: STATUS_STARTED_TIMEOUT_MS,
            overallTimeoutMs: LOCAL_SETUP_TIMEOUT_MS,
            notStartedMessage: "Couldn't confirm the local setup started — check whether a PowerShell window opened.",
            timedOutMessage: "The local setup is taking much longer than expected — check its PowerShell window.",
            closedMessage: "The local setup window was closed before it finished.",
            // No waitWhileAlive: LOCAL_SETUP_TIMEOUT_MS stays a hard limit (the
            // window itself says what it's doing; a retry re-attaches to it).
          }
        : {
            startedTimeoutMs: STATUS_STARTED_TIMEOUT_MS,
            overallTimeoutMs: LOCAL_SETUP_TIMEOUT_MS,
            notStartedMessage: "Couldn't confirm the local setup started.",
            timedOutMessage: "The local setup is taking much longer than expected.",
            closedMessage: "The local setup ended unexpectedly before it finished.",
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
    return {
      ok: true,
      message: process.platform === "win32" ? "Started the local setup in a PowerShell window." : "Started the local setup in the background.",
    };
  } catch (err) {
    grantedTaskInFlight = false;
    console.error("runLocalSetup failed:", err);
    return { ok: false, message: "Couldn't start the local setup." };
  }
}

async function startGranted(sender: WebContents): Promise<StartResult> {
  if (process.platform !== "win32" && process.platform !== "darwin") return NOT_WINDOWS;
  if (grantedTaskInFlight) return { ok: false, message: "Granted is already being set up or started." };
  grantedTaskInFlight = true;

  // Background (tray icon) when this install has the tray script; an older
  // install without it falls back to the console window it always used.
  // win32-gated, not just existsSync: scaffold/scripts/windows/*.ps1 are
  // ordinary files tracked in the repo, so a real `git clone` on macOS has
  // them too, same as on Windows — without this guard, `background` would
  // read true on a real mac install and route into launchTray() below,
  // which unconditionally runs powershell.exe (nonexistent on macOS,
  // throws, caught by the outer catch, and startGranted always fails).
  // There's no tray on darwin yet (a later, separate piece of work); this
  // is the same fallback path win32 takes for an install that predates it.
  const background = process.platform === "win32" && existsSync(trayScriptPath());
  const whereErrorsAre = background
    ? "right-click the Granted icon by the clock and choose Show log"
    : process.platform === "win32"
      ? "check its PowerShell window"
      : "check its log file";

  const finish = (state: "done" | "error", message: string | null, openedIn?: OpenIn): void => {
    grantedTaskInFlight = false;
    sendTaskStatus(sender, { task: "start-app", state, message, url: GRANTED_URL, background, ...(openedIn && { openedIn }) });
  };

  const openAndFinish = async (message: string | null): Promise<void> => {
    const openedIn = await openGrantedPage(GRANTED_URL);
    if (openedIn) finish("done", message, openedIn);
    else finish("done", `Granted is running, but it couldn't be opened automatically — if it hasn't opened, go to ${GRANTED_URL} yourself.`);
  };

  // Shared by "just launched it" and "it was already starting": wait for
  // Granted's page, then open the browser or report why not.
  const waitThenOpen = (readStatus: () => Promise<StatusFile | null>): void => {
    void waitForGrantedToStart({
      probe: () => probeGranted(GRANTED_PROBE_URL, PROBE_TIMEOUT_MS),
      readStatus,
      timeoutMs: APP_START_TIMEOUT_MS,
      intervalMs: 2000,
    })
      .then(async (outcome) => {
        if (outcome.ok) {
          await openAndFinish(null);
        } else if (outcome.reason === "exited") {
          // The tray reports a specific reason (e.g. the log's last error);
          // a closed window/tray, or an older console window, gets a generic one.
          const status = await readStatus();
          const specific = status?.state === "error" && !status.closed ? status.message : null;
          finish(
            "error",
            specific ??
              (background
                ? "Granted stopped before it finished starting (its tray icon was closed)."
                : process.platform === "win32"
                  ? "Granted stopped before it finished starting — the error is in its PowerShell window (if it's still open)."
                  : "Granted stopped before it finished starting."),
          );
        } else if (outcome.lastProbe === "other") {
          finish(
            "error",
            `Something is answering on port ${GRANTED_PORT}, but not with Granted's home page — if that's Granted showing an error, ${whereErrorsAre}.`,
          );
        } else {
          finish("error", `Granted didn't answer within ${APP_START_TIMEOUT_MS / 60_000} minutes — ${whereErrorsAre}.`);
        }
      })
      .catch((err: unknown) => {
        console.error("waiting for Granted failed:", err);
        finish("error", "Something went wrong while waiting for Granted to start.");
      });
  };

  try {
    // A window from an earlier attempt that's still running: wait on it
    // rather than starting a second server on the same port.
    // (A "done" server window means the server exited — never re-attach to that.)
    const existing = await reattachablePath("start-app", false);
    if (existing) {
      waitThenOpen(() => readTaskStatus(existing));
      return { ok: true, message: "Granted is already starting…", background };
    }

    const before = await probeGranted(GRANTED_PROBE_URL, ALREADY_RUNNING_PROBE_TIMEOUT_MS);
    if (before === "granted") {
      await openAndFinish("Granted was already running. It's open now.");
      return { ok: true, message: "Granted is already running.", background };
    }
    if (before === "busy") {
      // Something holds the port but is slow to answer — most likely a
      // Granted that's still compiling. Wait for it instead of launching a
      // second server that would just fail on the busy port.
      waitThenOpen(async () => null);
      return { ok: true, message: "Waiting for Granted…", background };
    }
    if (before === "other") {
      grantedTaskInFlight = false;
      return {
        ok: false,
        message: `Something is already using port ${GRANTED_PORT} and isn't showing Granted's home page. If it's another program, close it and try again; if it's Granted showing an error, ${whereErrorsAre}.`,
      };
    }

    const statusPath = background
      ? await launchTray()
      : process.platform === "win32"
        ? await launchScaffoldTask({
            task: "start-app",
            title: "Granted - keep this window open while you use Granted",
            command: "npm.cmd run dev",
            failureMessage: "Granted stopped. The error is shown above in this window.",
            // Next.js reads PORT; set it explicitly so the server is always where
            // the probe looks, whatever PORT the user's environment has.
            env: { PORT: String(GRANTED_PORT) },
          })
        : await launchMacScaffoldTask({
            task: "start-app",
            command: "npm",
            args: ["run", "dev"],
            failureMessage: "Granted stopped.",
            env: { PORT: String(GRANTED_PORT) },
          });
    waitThenOpen(() => readTaskStatus(statusPath));
    return { ok: true, message: "Starting Granted…", background };
  } catch (err) {
    grantedTaskInFlight = false;
    console.error("startGranted failed:", err);
    return { ok: false, message: "Couldn't start Granted." };
  }
}

function trayScriptPath(): string {
  return windowsScriptPath(scaffoldDir(), "granted-tray.ps1");
}

/**
 * Starts Granted in the background: granted-tray.ps1 runs `npm run dev`
 * hidden and shows a tray icon (Open / status / Show log / Restart / Quit),
 * so there's no console window to keep open. It reports through a status
 * file like the other windows (pid + lock), so a tray quit before Granted
 * answered reads as closed. The browser is opened here, not by the tray,
 * once Granted answers.
 */
async function launchTray(): Promise<string> {
  // git/Node were installed by a detached process after this app started,
  // so refresh PATH from the registry before the tray inherits it.
  await refreshWindowsPathEnv();
  const statusPath = newTaskStatusPath("start-app");
  const { file, args } = trayLaunchCommand({
    systemRoot: process.env["SystemRoot"] ?? "C:\\Windows",
    trayScript: trayScriptPath(),
    port: GRANTED_PORT,
    statusPath,
  });
  rememberLaunch("start-app", statusPath);
  // Through PowerShell's Start-Process, not spawn(conhost) — see
  // startProcessCommand. The PowerShell here only launches it and exits.
  await execFileAsync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", startProcessCommand(file, args)],
    { cwd: scaffoldDir(), windowsHide: true, timeout: 30_000 },
  );
  return statusPath;
}

/**
 * Creates the "Granted" shortcut(s) via scripts/windows/shortcuts.ps1 —
 * win32 only, unlike NOT_WINDOWS's other two call sites above: shortcuts
 * (and the tray, and Granted's own app window) stay Windows-only for now,
 * separate work from this task's status-reporting parity. Not reusing
 * NOT_WINDOWS's text here: that now says macOS is supported too, which
 * would be wrong for this specific feature. In practice this path is dead
 * on darwin anyway — getSetupState's shortcutsAvailable is explicitly
 * gated on process.platform === "win32" there (NOT because the install
 * lacks scripts/windows — shortcuts.ps1 is an ordinary file tracked in the
 * repo and present on a real clone on every platform), so the UI never
 * shows the checkboxes that would call this.
 */
async function createShortcuts(choice: ShortcutChoice): Promise<ShortcutsResult> {
  if (process.platform !== "win32") {
    return { ok: false, message: "Shortcuts are only available on Windows so far.", created: [] };
  }
  if (!choice.desktop && !choice.startMenu) return { ok: true, message: "No shortcuts requested.", created: [] };
  const script = windowsScriptPath(scaffoldDir(), "shortcuts.ps1");
  if (!existsSync(script)) {
    return { ok: false, message: "This copy of Granted is too old to add shortcuts — update it and try again.", created: [] };
  }
  const args = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script];
  if (choice.desktop) args.push("-Desktop");
  if (choice.startMenu) args.push("-StartMenu");
  if (process.env["GRANTED_PORT"]) args.push("-Port", String(GRANTED_PORT));
  // Test-only overrides, so the end-to-end tests never touch the real Desktop/Start menu.
  if (process.env["GRANTED_SHORTCUT_DESKTOP_DIR"]) args.push("-DesktopDir", process.env["GRANTED_SHORTCUT_DESKTOP_DIR"]);
  if (process.env["GRANTED_SHORTCUT_STARTMENU_DIR"]) args.push("-StartMenuDir", process.env["GRANTED_SHORTCUT_STARTMENU_DIR"]);
  try {
    const { stdout } = await execFileAsync("powershell.exe", args, { timeout: 30_000, windowsHide: true });
    const created = parseShortcutsOutput(stdout);
    if (!created) throw new Error(`unexpected output: ${stdout}`);
    const where = [choice.desktop && "your desktop", choice.startMenu && "the Start menu"].filter(Boolean).join(" and ");
    return { ok: true, message: `Added a Granted shortcut to ${where}.`, created };
  } catch (err) {
    console.error("createShortcuts failed:", err);
    return { ok: false, message: "Couldn't add the Granted shortcut(s). You can still open Granted from here.", created: [] };
  }
}

export function registerIpcHandlers(): void {
  ipcMain.handle("prereqs:check", () => checkPrereqs());
  ipcMain.handle("install:plan-version", (_event, checkForUpdates: unknown) => versionPlanner.plan(checkForUpdates === true));
  ipcMain.handle("terminal:open-install", (event, checkForUpdates: unknown) => openInstallTerminal(event.sender, checkForUpdates === true));
  ipcMain.handle("granted:get-setup-state", () => getSetupState(installDir(), settingsPath()));
  ipcMain.handle("granted:set-open-in", (_event, openIn: OpenIn) =>
    openIn === "window" || openIn === "browser"
      ? saveOpenIn(settingsPath(), openIn)
      : { ok: false, message: "Unknown place to open Granted." },
  );
  ipcMain.handle("granted:save-api-keys", (_event, keys: ApiKeysInput) => saveApiKeys(scaffoldDir(), keys));
  ipcMain.handle("granted:run-local-setup", (event) => runLocalSetup(event.sender));
  ipcMain.handle("granted:start", (event) => startGranted(event.sender));
  ipcMain.handle("granted:create-shortcuts", (_event, choice: ShortcutChoice) => createShortcuts(choice));
  ipcMain.on("app:quit", (event) => BrowserWindow.fromWebContents(event.sender)?.close());
}
