/**
 * Granted updating itself: what this install is, whether it can update
 * itself, the per-user settings (auto-update), and starting the updater.
 *
 * Only an install made by the Windows installer can update itself: it has
 * scripts/windows/update.ps1 and the installer's marker (.git\granted-
 * installer). A developer's own checkout is never touched — it's told what's
 * available and to `git pull` — and so is any other platform for now.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
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
 * The per-user settings file the Windows tray, open-granted.ps1 and the
 * installer share: %LOCALAPPDATA%\Granted\settings.json (GRANTED_SETTINGS_PATH
 * overrides it, for tests). Elsewhere, ~/.granted/settings.json.
 */
export function settingsPath(env: Record<string, string | undefined> = process.env): string {
  if (env["GRANTED_SETTINGS_PATH"]) return env["GRANTED_SETTINGS_PATH"];
  const base = env["LOCALAPPDATA"] ? join(env["LOCALAPPDATA"], "Granted") : join(homedir(), ".granted");
  return join(base, "settings.json");
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
