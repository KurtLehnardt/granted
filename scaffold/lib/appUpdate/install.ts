/**
 * Granted updating itself: what this install is, whether it can update
 * itself, the per-user settings (auto-update), and starting the updater.
 *
 * Only an install one of the installers made can update itself: it has the
 * installer's marker (.git/granted-installer) and the updater for its platform
 * — scripts/windows/update.ps1 or scripts/macos/update.sh. A developer's own
 * checkout is never touched (it's told what's available and to `git pull`), and
 * neither is a platform with no installer of its own.
 *
 * This file also owns the other thing an install can do to itself:
 * uninstalling (uninstallInfo/startUninstaller, below). That is macOS-only and
 * on purpose — on Windows, Granted is uninstalled from Windows' own "Installed
 * apps" list, which scripts/windows/uninstall.ps1 registers it in. macOS has no
 * such list, so the work order puts uninstall in the menu-bar menu and in
 * Settings → About Granted, which is what this half serves.
 */
import { execFile, spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path, { dirname, join } from "node:path";

/** The scaffold folder the server runs in (`npm run dev` starts there). */
export function scaffoldDir(): string {
  return process.cwd();
}

/** This install's version: scaffold/package.json. */
export function appVersion(dir = scaffoldDir()): string {
  try {
    const v = (JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { version?: unknown }).version;
    return typeof v === "string" ? v : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export type CannotUpdateReason = "unsupported-platform" | "not-installer-made" | "no-updater";

export interface InstallInfo {
  installDir: string;
  canUpdate: boolean;
  /** Why it can't update itself (null when it can). */
  reason: CannotUpdateReason | null;
  /**
   * The updater this install would run, and the one startUpdater() is given to
   * run (null when it has none it may run) — as uninstallInfo().script is what
   * startUninstaller() is given. Neither path is worked out twice.
   */
  script: string | null;
}

/** How one platform's updater is started (see startUpdater below). */
type StartUpdater = (ref: string, port: number, script: string, deps: StartUpdaterDeps) => Promise<void>;

interface Updater {
  /** Where the updater lives, relative to scaffold/. */
  readonly script: readonly string[];
  /** How it has to be started so that it outlives the server it stops. */
  readonly start: StartUpdater;
}

/**
 * The updater each platform has. A platform that isn't in here has no in-app
 * update at all: that is what "unsupported-platform" means, and adding one is
 * adding a line here — the script's place and how to start it — plus the
 * script itself.
 *
 * This table is the only place either of those two answers lives: installInfo()
 * below reports the script from it, and startUpdater() dispatches on it. So an
 * install can never be offered an update for a platform with no updater, nor
 * handed a DIFFERENT platform's: a platform that isn't in this table is refused
 * by startUpdater() rather than falling back to one that is.
 */
const UPDATERS: Partial<Record<NodeJS.Platform, Updater>> = {
  win32: { script: ["scripts", "windows", "update.ps1"], start: startWindowsUpdater },
  darwin: { script: ["scripts", "macos", "update.sh"], start: startMacUpdater },
};

/**
 * Whether this install can update itself from Settings → About Granted, and
 * with what.
 *
 * The same three-part test uninstallInfo() makes below, for the same reasons:
 * the platform has an updater at all, the installer's `.git/granted-installer`
 * marker is there (so a developer's own checkout is never switched to another
 * release under them), and the script itself is present (an install made before
 * that platform had one).
 */
export function installInfo(
  dir = scaffoldDir(),
  platform: NodeJS.Platform = process.platform,
  exists: (p: string) => boolean = existsSync,
): InstallInfo {
  // Windows paths for the Windows answer and POSIX ones for the macOS answer,
  // whatever platform is asking (a test of either runs on both CI runners) —
  // the convention settingsPath() below records in full.
  const p = platform === "win32" ? path.win32 : platform === "darwin" ? path.posix : path;
  const installDir = p.resolve(dir, "..");
  const relative = UPDATERS[platform]?.script;
  const script = relative ? p.join(dir, ...relative) : null;
  let reason: CannotUpdateReason | null = null;
  if (!script) reason = "unsupported-platform";
  else if (!exists(p.join(installDir, ".git", "granted-installer"))) reason = "not-installer-made";
  else if (!exists(script)) reason = "no-updater";
  return { installDir, canUpdate: reason === null, reason, script: reason === null ? script : null };
}

/**
 * The per-user settings file the trays, open-granted.ps1 and the installer
 * all share:
 *   %LOCALAPPDATA%\Granted\settings.json                        (Windows)
 *   ~/Library/Application Support/Granted/settings.json         (macOS)
 *   ~/.granted/settings.json                                    (elsewhere)
 *
 * macOS uses the platform's own per-user application-support folder, which is
 * also what scaffold/scripts/macos/granted-tray.sh and the Swift menu-bar
 * helper read and write — so the same `openIn` / `autoUpdate` /
 * `lastAutoCheck` keys Windows uses are shared there too, rather than living
 * in a second file under ~/.granted.
 *
 * GRANTED_SETTINGS_PATH overrides all of them (tests). LOCALAPPDATA is
 * checked before the platform so a Windows-path test can run on any OS.
 * `home` is injectable for the same reason.
 *
 * Each branch joins with the separator of the platform it describes, never the
 * ambient `join` (which is whichever platform this process happens to be
 * running on). The same mistake in installer/src/main/ipcPure.ts's
 * grantedSettingsPath did fail CI on the windows-latest runner; here it stayed
 * hidden because the test re-derived its expected value with the same ambient
 * `join`, which cannot catch a separator bug. The tests now assert literal
 * paths instead.
 */
export function settingsPath(
  env: Record<string, string | undefined> = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): string {
  if (env["GRANTED_SETTINGS_PATH"]) return env["GRANTED_SETTINGS_PATH"];
  if (env["LOCALAPPDATA"]) return path.win32.join(env["LOCALAPPDATA"], "Granted", "settings.json");
  if (platform === "darwin") return path.posix.join(home, "Library", "Application Support", "Granted", "settings.json");
  return (platform === "win32" ? path.win32 : path.posix).join(home, ".granted", "settings.json");
}

function readSettings(path: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export interface UpdateSettings {
  /** Install new releases automatically (when Granted is opened). Off unless turned on. */
  autoUpdate: boolean;
  /** When an automatic check last ran (ms since epoch), so it isn't every page load. */
  lastAutoCheck: number | null;
}

export function readUpdateSettings(path = settingsPath()): UpdateSettings {
  const s = readSettings(path);
  return {
    autoUpdate: s["autoUpdate"] === true,
    lastAutoCheck: typeof s["lastAutoCheck"] === "number" ? s["lastAutoCheck"] : null,
  };
}

/** Saves the given update settings, keeping everything else in the file. */
export function writeUpdateSettings(changes: Partial<UpdateSettings>, path = settingsPath()): void {
  const next = { ...readSettings(path), ...changes };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(next), "utf8");
}

/** Where the updater reports progress: next to the settings file. */
export function updateStatusPath(env: Record<string, string | undefined> = process.env): string {
  return join(dirname(settingsPath(env)), "update-status.json");
}

export interface UpdateStatus {
  state: "running" | "done" | "error";
  from?: string;
  to?: string;
  message?: string | null;
  at?: string;
}

/** Writes the update status (the server marks "running" itself before starting the updater). */
export function writeUpdateStatus(status: UpdateStatus, file = updateStatusPath()): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(status), "utf8");
}

export function readUpdateStatus(path = updateStatusPath()): UpdateStatus | null {
  try {
    const s = JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, "")) as UpdateStatus;
    return s.state === "running" || s.state === "done" || s.state === "error" ? s : null;
  } catch {
    return null;
  }
}

/**
 * Starts `file args\u2026` in its own session, with its output in a file and nothing
 * linking it back to this process, and resolves with that file's path as soon as
 * it is running.
 *
 * This is how both of the things an install does to ITSELF are started on
 * macOS \u2014 the updater and the uninstaller \u2014 because both of them stop this very
 * server partway through. A child of this process would be killed with it
 * (Windows solves the same problem by going through Start-Process; see
 * startUpdater below). `detached` is what matters, not `nohup`: a new session
 * has no controlling terminal to be hung up on, and launchd's teardown of this
 * server's job does not reach it. Its output goes to a file, so nothing is
 * written to a pipe whose other end is about to be gone, and the working
 * directory is "/" so it never holds a folder the script is about to replace or
 * delete. Resolving on "spawn" rather than "exit" is the honest contract: this
 * never exits before the server it is stopping.
 */
function startDetached(
  file: string,
  args: string[],
  logPath: string,
  deps: { spawnImpl?: typeof spawn; openImpl?: typeof openSync; closeImpl?: typeof closeSync } = {},
): Promise<string> {
  let out: number | "ignore" = "ignore";
  try {
    out = (deps.openImpl ?? openSync)(logPath, "a");
  } catch {
    out = "ignore";
  }
  const child = (deps.spawnImpl ?? spawn)(file, args, {
    cwd: "/",
    detached: true,
    stdio: ["ignore", out, out],
  });
  child.unref?.();
  return new Promise((resolveStart, rejectStart) => {
    const release = (): void => {
      // The child has its own copy of the descriptor from here on.
      if (typeof out === "number") {
        try {
          (deps.closeImpl ?? closeSync)(out);
        } catch {
          /* already closed */
        }
      }
    };
    child.once?.("error", (err: Error) => {
      release();
      rejectStart(err);
    });
    child.once?.("spawn", () => {
      release();
      resolveStart(logPath);
    });
  });
}

/** The PowerShell -Command that starts `file args…` via Start-Process, everything a single-quoted literal. */
export function startProcessCommand(file: string, args: string[]): string {
  const q = (s: string): string => `'${s.replace(/'/g, "''")}'`;
  const argLine = args.map((a) => (/[\s"]/.test(a) || a === "" ? `"${a.replace(/"/g, '\\"')}"` : a)).join(" ");
  return `Start-Process -FilePath ${q(file)} -ArgumentList ${q(argLine)}`;
}

/** Where a started updater's own output goes: the temporary folder, as the uninstaller's does. */
export function updateLogPath(now: Date = new Date(), dir: string = tmpdir()): string {
  return join(dir, `granted-update-${now.toISOString().replace(/[:.]/g, "-")}.log`);
}

export type StartUpdaterDeps = {
  /** The scaffold folder the Windows launcher runs in (the updater's own path is passed in). */
  dir?: string;
  platform?: NodeJS.Platform;
  systemRoot?: string;
  spawnImpl?: typeof spawn;
  openImpl?: typeof openSync;
  closeImpl?: typeof closeSync;
  logPath?: string;
};

/**
 * Starts this platform's updater — `script`, which is installInfo().script, the
 * same path that said this install can update itself at all — for `ref`, out of
 * this server's process tree (the update stops this very server), and resolves
 * once it is running (or rejects if it couldn't be started, so the caller can
 * report a launch failure instead of "started").
 *
 * The script is passed in rather than worked out again here, exactly as
 * startUninstaller() takes uninstallInfo().script: one path, decided in one
 * place, so what the Settings page was told can update itself is the very thing
 * that gets run.
 *
 * Which platform's launcher runs comes from the UPDATERS table above and from
 * nothing else. A platform that isn't in it is refused here, loudly: it used to
 * be `platform === "darwin" ? mac : windows`, which made Windows the implicit
 * answer for every other platform — so a platform added to UPDATERS exactly as
 * that table says would have been told it could update itself (installInfo())
 * and then handed the Windows PowerShell updater to run against it.
 *
 * The platforms need different mechanisms for the same requirement — the
 * updater has to outlive the server that started it — which is why each has its
 * own launcher below rather than one call for both.
 */
export function startUpdater(ref: string, port: number, script: string, deps: StartUpdaterDeps = {}): Promise<void> {
  const platform = deps.platform ?? process.platform;
  const updater = UPDATERS[platform];
  if (!updater) return Promise.reject(new Error(`Granted can't update itself on ${platform}.`));
  return updater.start(ref, port, script, deps);
}

/**
 * macOS: the install's own scripts/macos/update.sh, started the way
 * startUninstaller starts the uninstaller — its own session, a working
 * directory outside the install, and its output in a file (startDetached above
 * says why each of those matters). This is what the work order means by
 * starting it detached: the script itself does not daemonize, exactly as
 * update.ps1 does not.
 */
function startMacUpdater(ref: string, port: number, script: string, deps: StartUpdaterDeps): Promise<void> {
  return startDetached("/bin/bash", [script, "--ref", ref, "--port", String(port)], deps.logPath ?? updateLogPath(), deps).then(
    () => undefined,
  );
}

/**
 * Windows: the install's own scripts/windows/update.ps1. A short-lived
 * PowerShell starts conhost --headless (no console window, even where Windows
 * Terminal is the default) with Start-Process (ShellExecute: nothing
 * inherited) and exits; from then on nothing links the updater to the server,
 * so stopping the server's tree doesn't reach it.
 *
 * NOT `detached: true`: that gives the PowerShell no console at all, and it
 * then exits without running its -Command (seen on Windows 11) — the update
 * would never start.
 */
function startWindowsUpdater(ref: string, port: number, script: string, deps: StartUpdaterDeps): Promise<void> {
  const dir = deps.dir ?? scaffoldDir();
  const systemRoot = deps.systemRoot ?? process.env["SystemRoot"] ?? "C:\\Windows";
  // Windows-only: Windows paths whatever the test OS.
  const conhost = path.win32.join(systemRoot, "System32", "conhost.exe");
  const powershell = path.win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const command = startProcessCommand(conhost, [
    "--headless",
    powershell,
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    script,
    "-Ref",
    ref,
    "-Port",
    String(port),
  ]);
  const child = (deps.spawnImpl ?? spawn)(powershell, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command], {
    cwd: dir,
    windowsHide: true,
    stdio: "ignore",
  });
  // Resolves once the launcher has handed off (or rejects if it couldn't),
  // so the caller can report a launch failure instead of "started".
  return new Promise((resolveStart, rejectStart) => {
    child.once?.("error", rejectStart);
    child.once?.("exit", (code: number | null) =>
      code === 0 ? resolveStart() : rejectStart(new Error(`the updater couldn't be started (exit code ${code})`)),
    );
  });
}

// --- uninstalling (macOS) ---------------------------------------------------

export type CannotUninstallReason = "not-macos" | "not-installer-made" | "no-uninstaller";

export interface UninstallInfo {
  installDir: string;
  canUninstall: boolean;
  /** Why it can't uninstall itself (null when it can). */
  reason: CannotUninstallReason | null;
  /** The uninstaller this install would run (null when it has none it may run). */
  script: string | null;
}

/**
 * Whether this install can uninstall itself from Settings → About Granted, and
 * with what.
 *
 * The same three-part test installInfo() makes for updating, for the same
 * reasons: the platform, the installer's `.git/granted-installer` marker (so a
 * developer's own checkout is never offered a button that would delete it), and
 * the script itself being present (an install made before this existed).
 *
 * macOS only. Windows installs are uninstalled from Windows' "Installed apps"
 * list, which is where a Windows user looks and which scripts/windows/
 * uninstall.ps1 already registers Granted in; putting a second, different
 * uninstall button inside the app there would be two mechanisms for one job.
 */
export function uninstallInfo(
  dir = scaffoldDir(),
  platform: NodeJS.Platform = process.platform,
  exists: (p: string) => boolean = existsSync,
): UninstallInfo {
  // POSIX paths for the macOS answer, whatever platform is asking (a test of
  // it runs on Windows CI too) — the convention this file's settingsPath()
  // records.
  const p = platform === "darwin" ? path.posix : path;
  const installDir = p.resolve(dir, "..");
  const script = p.join(dir, "scripts", "macos", "uninstall.sh");
  let reason: CannotUninstallReason | null = null;
  if (platform !== "darwin") reason = "not-macos";
  else if (!exists(p.join(installDir, ".git", "granted-installer"))) reason = "not-installer-made";
  else if (!exists(script)) reason = "no-uninstaller";
  return { installDir, canUninstall: reason === null, reason, script: reason === null ? script : null };
}

export interface UninstallChoice {
  /** Copy the API keys and settings somewhere safe first (the script's own default). */
  keepKeys: boolean;
  /** Delete the folder even though it holds work that isn't on GitHub. */
  force: boolean;
}

/**
 * The uninstall.sh arguments for one choice.
 *
 * Always --quiet: the asking is done in the page, which is the only place that
 * can ask a person sitting in front of a browser. (The script's own dialogs are
 * for the menu-bar item, which has no page.) --force is therefore passed only
 * when the page actually showed the unsaved work and the user said yes anyway
 * — exactly the rule --quiet and --force are there to enforce.
 */
export function uninstallArgs(script: string, choice: UninstallChoice): string[] {
  const args = [script, "--quiet", choice.keepKeys ? "--keep-keys" : "--no-keep-keys"];
  if (choice.force) args.push("--force");
  return args;
}

/** uninstall.sh --check: what an uninstall would find, changing nothing. */
export function uninstallCheckArgs(script: string): string[] {
  return [script, "--check"];
}

export interface UninstallCheck {
  installDir: string;
  grantedInstall: boolean;
  installerMade: boolean;
  /** Work in the folder that isn't on GitHub, in the script's own words. */
  unsaved: string[];
  /** The API-key and settings files a copy would be kept of. */
  keyFiles: string[];
  /** Where that copy would go. */
  backupDir: string;
}

/** uninstall.sh --check's JSON → what it found (null if the output isn't that shape). */
export function parseUninstallCheck(stdout: string): UninstallCheck | null {
  try {
    const line = stdout.trim().split(/\r?\n/).filter(Boolean).pop() ?? "";
    const parsed = JSON.parse(line) as Record<string, unknown>;
    if (parsed["check"] !== true) return null;
    const strings = (value: unknown): string[] =>
      Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
    return {
      installDir: typeof parsed["installDir"] === "string" ? parsed["installDir"] : "",
      grantedInstall: parsed["grantedInstall"] === true,
      installerMade: parsed["installerMade"] === true,
      unsaved: strings(parsed["unsaved"]),
      keyFiles: strings(parsed["keyFiles"]),
      backupDir: typeof parsed["backupDir"] === "string" ? parsed["backupDir"] : "",
    };
  } catch {
    return null;
  }
}

/** Runs uninstall.sh --check (which changes nothing) and reads its answer. */
export async function readUninstallCheck(
  script: string,
  deps: { execFileImpl?: typeof execFile } = {},
): Promise<UninstallCheck | null> {
  const run = deps.execFileImpl ?? execFile;
  return new Promise((resolveCheck) => {
    run("/bin/bash", uninstallCheckArgs(script), { timeout: 30_000 }, (_err, stdout) => {
      resolveCheck(parseUninstallCheck(typeof stdout === "string" ? stdout : String(stdout ?? "")));
    });
  });
}

/** Where a started uninstaller's output goes: the temporary folder, never a folder it deletes. */
export function uninstallLogPath(now: Date = new Date(), dir: string = tmpdir()): string {
  return join(dir, `granted-uninstall-${now.toISOString().replace(/[:.]/g, "-")}.log`);
}

/**
 * What a started uninstaller actually did, read back from the log it writes.
 *
 * This is the only way the server can ever learn the answer. startUninstaller
 * resolves when the script has been SPAWNED, which is the honest contract (the
 * script outlives this server by design — it stops it), but it means "started"
 * is all the POST can report. The script can still refuse afterwards: exit 3
 * when the install's parent folder can't be written to, or exit 1 when the copy
 * of the API keys couldn't be made — and both of those leave Granted running,
 * whole and uninstallable again. Its one JSON line in the log is what says so.
 */
export interface UninstallOutcome {
  removed: boolean;
  /** The script's own reason when it refused ("access-denied", "files-in-use", "error"…). */
  reason: string | null;
  /** What it said about that reason, where it said anything. */
  detail: string | null;
  /** Where the copy of the API keys really went, if one was kept. */
  keptKeys: string | null;
  /** A moved-aside folder it couldn't finish deleting. */
  leftover: string | null;
}

/** The uninstaller's last JSON line → what it did (null while it hasn't printed one). */
export function parseUninstallOutcome(log: string): UninstallOutcome | null {
  const line = log.trim().split(/\r?\n/).filter(Boolean).pop() ?? "";
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (typeof parsed["removed"] !== "boolean") return null;
  const str = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null);
  return {
    removed: parsed["removed"],
    reason: str(parsed["reason"]),
    detail: str(parsed["detail"]),
    keptKeys: str(parsed["keptKeys"]),
    leftover: str(parsed["leftover"]),
  };
}

/** The same, from the log file itself (null when there is no readable answer in it yet). */
export function readUninstallOutcome(path: string, read: (p: string) => string = (p) => readFileSync(p, "utf8")): UninstallOutcome | null {
  try {
    return parseUninstallOutcome(read(path));
  } catch {
    return null;
  }
}

/**
 * Starts scripts/macos/uninstall.sh for this install and resolves as soon as it
 * is running, with the path of the log it is writing to.
 *
 * Detached, with no inherited stdio and a working directory of "/", because of
 * what it is about to do: it stops this very server (and the menu-bar helper,
 * and the LaunchAgent they run under). A child of this process would be killed
 * partway through the uninstall it was asked to perform — the same hazard
 * startUpdater goes through Start-Process to avoid on Windows, and the same one
 * the macOS updater has, which is why both go through the one startDetached
 * above.
 */
export function startUninstaller(
  script: string,
  choice: UninstallChoice,
  deps: { spawnImpl?: typeof spawn; openImpl?: typeof openSync; closeImpl?: typeof closeSync; logPath?: string } = {},
): Promise<string> {
  return startDetached("/bin/bash", uninstallArgs(script, choice), deps.logPath ?? uninstallLogPath(), deps);
}
