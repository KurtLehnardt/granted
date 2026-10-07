/**
 * Granted updating itself: what this install is, whether it can update
 * itself, the per-user settings (auto-update), and starting the updater.
 *
 * Only an install made by the Windows installer can update itself: it has
 * scripts/windows/update.ps1 and the installer's marker (.git\granted-
 * installer). A developer's own checkout is never touched — it's told what's
 * available and to `git pull` — and so is any other platform for now.
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

export type CannotUpdateReason = "not-windows" | "not-installer-made" | "no-updater";

export interface InstallInfo {
  installDir: string;
  canUpdate: boolean;
  /** Why it can't update itself (null when it can). */
  reason: CannotUpdateReason | null;
}

export function installInfo(
  dir = scaffoldDir(),
  platform: NodeJS.Platform = process.platform,
  exists: (p: string) => boolean = existsSync,
): InstallInfo {
  // Windows paths on Windows (and in tests of it on any OS).
  const p = platform === "win32" ? path.win32 : path;
  const installDir = p.resolve(dir, "..");
  let reason: CannotUpdateReason | null = null;
  if (platform !== "win32") reason = "not-windows";
  else if (!exists(p.join(installDir, ".git", "granted-installer"))) reason = "not-installer-made";
  else if (!exists(p.join(dir, "scripts", "windows", "update.ps1"))) reason = "no-updater";
  return { installDir, canUpdate: reason === null, reason };
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

/** Where update.ps1 reports progress: next to the settings file. */
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

/** Writes the update status (the server marks "running" itself before starting update.ps1). */
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

/** The PowerShell -Command that starts `file args…` via Start-Process, everything a single-quoted literal. */
export function startProcessCommand(file: string, args: string[]): string {
  const q = (s: string): string => `'${s.replace(/'/g, "''")}'`;
  const argLine = args.map((a) => (/[\s"]/.test(a) || a === "" ? `"${a.replace(/"/g, '\\"')}"` : a)).join(" ");
  return `Start-Process -FilePath ${q(file)} -ArgumentList ${q(argLine)}`;
}

/**
 * Starts scripts/windows/update.ps1 for `ref`, out of this server's process
 * tree — the update stops this very server. A short-lived PowerShell starts
 * conhost --headless (no console window, even where Windows Terminal is the
 * default) with Start-Process (ShellExecute: nothing inherited) and exits;
 * from then on nothing links the updater to the server, so stopping the
 * server's tree doesn't reach it.
 *
 * NOT `detached: true`: that gives the PowerShell no console at all, and it
 * then exits without running its -Command (seen on Windows 11) — the update
 * would never start.
 */
export function startUpdater(
  ref: string,
  port: number,
  deps: { dir?: string; systemRoot?: string; spawnImpl?: typeof spawn } = {},
): Promise<void> {
  const dir = deps.dir ?? scaffoldDir();
  const systemRoot = deps.systemRoot ?? process.env["SystemRoot"] ?? "C:\\Windows";
  // Windows-only: Windows paths whatever the test OS.
  const conhost = path.win32.join(systemRoot, "System32", "conhost.exe");
  const powershell = path.win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const updater = path.win32.join(dir, "scripts", "windows", "update.ps1");
  const command = startProcessCommand(conhost, [
    "--headless",
    powershell,
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    updater,
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
 * Starts scripts/macos/uninstall.sh for this install and resolves as soon as it
 * is running, with the path of the log it is writing to.
 *
 * Detached, with no inherited stdio and a working directory of "/", because of
 * what it is about to do: it stops this very server (and the menu-bar helper,
 * and the LaunchAgent they run under). A child of this process would be killed
 * partway through the uninstall it was asked to perform — the same hazard
 * startUpdater above goes through Start-Process to avoid on Windows, solved
 * here the way the work order names for macOS: its own session, surviving the
 * process that asked for it.
 *
 * `detached` is what matters, not `nohup`: a new session has no controlling
 * terminal to be hung up on, and launchd's teardown of this server's job does
 * not reach it. Its output goes to a file, so nothing is written to a pipe
 * whose other end is about to be gone. Resolving on "spawn" rather than "exit"
 * is the honest contract: this never exits before the server it is stopping.
 */
export function startUninstaller(
  script: string,
  choice: UninstallChoice,
  deps: { spawnImpl?: typeof spawn; openImpl?: typeof openSync; closeImpl?: typeof closeSync; logPath?: string } = {},
): Promise<string> {
  const logPath = deps.logPath ?? uninstallLogPath();
  let out: number | "ignore" = "ignore";
  try {
    out = (deps.openImpl ?? openSync)(logPath, "a");
  } catch {
    out = "ignore";
  }
  const child = (deps.spawnImpl ?? spawn)("/bin/bash", uninstallArgs(script, choice), {
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
