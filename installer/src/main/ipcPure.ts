/**
 * Pure logic behind ipc.ts's Electron IPC handlers, factored out into its
 * own dependency-free module (no `electron` import) for the same reason
 * `shared/ipc.ts` is dependency-free: `require("electron")` outside a
 * running Electron process resolves to a path string, not the
 * `{ clipboard, ipcMain, ... }` API — so a plain Node/tsx test runner can
 * never import anything from a file that imports `electron` at module
 * scope, even to reach code that never touches the Electron API at all.
 * Everything genuinely pure lives here instead, directly unit-testable;
 * ipc.ts imports from this module rather than defining these inline.
 */
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import type { InstallStatusEvent } from "../shared/ipc";

/** The regex-extraction half of checkVersionedTool. */
export function parseVersionFromOutput(stdout: string): { version: string | null; major: number | null } {
  const match = stdout.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) {
    return { version: stdout.trim() || null, major: null };
  }
  return { version: match[0], major: Number.parseInt(match[1], 10) };
}

/**
 * Merge/dedupe logic behind refreshWindowsPathEnv. Rebuilds from
 * `originalPath` every call rather than appending to whatever PATH
 * currently is — an earlier version appended, and a real validation pass
 * on actual Windows caught it growing unbounded: every failed check
 * re-ran this and tacked on a full fresh copy of the registry PATH,
 * eventually saturating Windows's 32,767-char env-var limit (measured:
 * ~16-120 failed checks depending on how long the real machine's PATH
 * already is) — at which point SetEnvironmentVariableW silently stops
 * applying further changes, and the exact bug this function exists to
 * fix comes back. Rebuilding from a fixed origin makes repeated calls
 * idempotent: the result stabilizes after the first call and never grows
 * again. Deduped case-insensitively since Windows paths are. Returns
 * `null` (no-op signal) when the registry read came back with nothing —
 * the caller must not overwrite the live PATH with a stale `originalPath`
 * in that case.
 */
export function mergeRegistryPath(originalPath: string, registryStdout: string): string | null {
  const registryEntries = registryStdout
    .trim()
    .split(";")
    .filter((entry) => entry.length > 0);
  if (registryEntries.length === 0) return null;
  const originalEntries = originalPath.split(";").filter((entry) => entry.length > 0);
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const entry of [...originalEntries, ...registryEntries]) {
    const key = entry.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      merged.push(entry);
    }
  }
  return merged.join(";");
}

/**
 * BOM-strip + JSON.parse + state validation. Windows PowerShell 5.1's
 * `Set-Content -Encoding utf8` (unlike PowerShell Core's `pwsh`) writes a
 * UTF-8 BOM, and JSON.parse rejects a leading U+FEFF. A real Windows
 * validation pass caught this silently breaking status reporting
 * entirely: `powershell.exe` 5.1 — not `pwsh`, which is what the fix was
 * first (insufficiently) verified under — is what install-windows.ps1
 * actually runs under in production, so this strip is required for every
 * real run, not a defensive nicety. Any malformed/unexpected content (not
 * just a missing BOM) returns `null`, read by the caller as "no status
 * yet" — never thrown.
 */
export function parseInstallStatusJson(raw: string): InstallStatusEvent | null {
  try {
    const withoutBom = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
    const parsed = JSON.parse(withoutBom) as Partial<InstallStatusEvent>;
    if (parsed.state === "running" || parsed.state === "done" || parsed.state === "error") {
      return { state: parsed.state, message: parsed.message ?? null };
    }
    return null;
  } catch {
    return null;
  }
}

/** AppleScript string-literal escaping (backslashes and double quotes only). */
export function escapeForAppleScript(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** Single-quoted PowerShell string literal — safe against `$`/backtick
 * expansion regardless of what the path contains (a double-quoted PS
 * string would expand both). Only a literal single quote needs escaping,
 * by doubling it. */
export function psSingleQuoted(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * A fresh, unique status-file path per launch attempt (not a fixed name)
 * specifically so a prior attempt that was given up on (timed out, but
 * still actually running in its own detached, unref'd process) can never
 * have its later writes land in the file a LATER attempt is polling — a
 * fixed shared path would let an abandoned install's late "done" mislead
 * a subsequent one.
 */
export function newInstallStatusPath(): string {
  return join(tmpdir(), `granted-install-status-${randomUUID()}.json`);
}

// ---------------------------------------------------------------------------
// "Open Granted" — .env.local handling. Same contract as
// scaffold/scripts/setup.mjs (re-implemented, not imported, for the same
// reason NODE_MAJOR_MIN is: installer/ doesn't depend on scaffold/): never
// overwrite a real value that's already set, and treat .env.example's
// placeholders as unset.
// ---------------------------------------------------------------------------

/** Value already set for `key` in env text, or "" if blank/absent. */
export function currentEnvValue(text: string, key: string): string {
  const m = text.match(new RegExp(`^${key}=(.*)$`, "m"));
  return m ? m[1].trim() : "";
}

/** Replace `key=...` in place, or append it if the key isn't present. */
export function upsertEnv(text: string, key: string, value: string): string {
  const line = `${key}=${value}`;
  if (new RegExp(`^${key}=.*$`, "m").test(text)) {
    return text.replace(new RegExp(`^${key}=.*$`, "m"), () => line);
  }
  return `${text.replace(/\s*$/, "")}\n${line}\n`;
}

/** .env.example ships `sk-...` / `sk-ant-...` as placeholders — those count as unset. */
export function isRealKey(value: string): boolean {
  return value !== "" && !value.startsWith("sk-...") && value !== "sk-ant-...";
}

/**
 * Whether `npm run setup:local` got all the way through. Its env lines alone
 * aren't proof: setup-local.mjs writes them (step 6) BEFORE the corpus
 * re-embed (step 7), which can still fail — leaving an .env.local that
 * points at Ollama with a corpus whose vectors don't match (broken
 * retrieval). The re-embed's very last write is data/local/corpus-meta.json,
 * stamped with the model it used, so that must exist and match too.
 */
export function envIsLocalConfigured(text: string, localCorpusMetaJson: string | null): boolean {
  if (currentEnvValue(text, "LLM_PROVIDER") !== "ollama" || currentEnvValue(text, "EMBEDDINGS_BASE_URL") === "") {
    return false;
  }
  try {
    const raw = localCorpusMetaJson ?? "";
    const meta = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw) as { embeddingModel?: unknown; dims?: unknown };
    const model = currentEnvValue(text, "EMBEDDINGS_MODEL");
    return model !== "" && meta.embeddingModel === model && typeof meta.dims === "number" && meta.dims > 0;
  } catch {
    return false;
  }
}

/**
 * Merge the form's keys into env text. A key the user typed replaces
 * whatever was there — they asked for it explicitly (setup.mjs's "never
 * overwrite" rule exists because it never re-prompts for a key that's
 * already set; this form does show those fields). A blank field keeps the
 * existing value. `missing` lists required keys still unset afterwards, so
 * the caller can refuse to start an app that can't work yet.
 */
export function applyApiKeys(
  text: string,
  keys: { OPENAI_API_KEY: string; ANTHROPIC_API_KEY: string; EXA_API_KEY: string },
): { text: string; missing: string[] } {
  let out = text;
  for (const [key, raw] of Object.entries(keys)) {
    const value = raw.trim();
    if (value !== "") out = upsertEnv(out, key, value);
  }
  const missing = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY"].filter((k) => !isRealKey(currentEnvValue(out, k)));
  return { text: out, missing };
}

// ---------------------------------------------------------------------------
// "Open Granted" — running scaffold commands in their own console window.
// ---------------------------------------------------------------------------

/**
 * The .ps1 that runs one scaffold command in its own visible PowerShell
 * window and reports the outcome through a status file, in the same
 * {"state": ...} format install-windows.ps1 writes (so
 * parseInstallStatusJson reads both) plus the window's own `pid` — so the
 * app can tell "still running" from "the user closed the window", which
 * otherwise looks identical (nothing ever writes done/error). Like
 * install-windows.ps1 it also holds an exclusive lock on `<status>.lock` for
 * the window's lifetime (see STATUS_LOCK_LINE). Everything interpolated is
 * single-quoted (psSingleQuoted), so a `$` or backtick in a path is taken
 * literally. `command` is only ever a fixed string chosen by the main
 * process, never user input.
 */
export function buildTaskScript(opts: {
  title: string;
  cwd: string;
  statusPath: string;
  command: string;
  failureMessage: string;
  /** Extra environment variables for the command (e.g. PORT for `npm run dev`). */
  env?: Record<string, string>;
}): string {
  const envLines = Object.entries(opts.env ?? {}).map(([key, value]) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`Invalid environment variable name: ${key}`);
    return `$env:${key} = ${psSingleQuoted(value)}`;
  });
  return [
    `$Host.UI.RawUI.WindowTitle = ${psSingleQuoted(opts.title)}`,
    `$StatusPath = ${psSingleQuoted(opts.statusPath)}`,
    STATUS_LOCK_LINE,
    ...envLines,
    "function Write-Status($state, $message) {",
    "  try {",
    "    @{ state = $state; message = $message; pid = $PID } | ConvertTo-Json -Compress | Set-Content -Path $StatusPath -Encoding utf8 -ErrorAction Stop",
    "  } catch {",
    '    Write-Host "  [!] Couldn\'t write status to $StatusPath -- $($_.Exception.Message)" -ForegroundColor Yellow',
    "  }",
    "}",
    'Write-Status "running" $null',
    `Set-Location -LiteralPath ${psSingleQuoted(opts.cwd)}`,
    opts.command,
    "if ($LASTEXITCODE -eq 0) {",
    '  Write-Status "done" $null',
    "} else {",
    `  Write-Status "error" ${psSingleQuoted(opts.failureMessage)}`,
    `  Write-Host "\`n  [x] " -NoNewline -ForegroundColor Red; Write-Host ${psSingleQuoted(opts.failureMessage)} -ForegroundColor Red`,
    "}",
    "",
  ].join("\r\n");
}

/**
 * Opened once at the top of every status-reporting script (this one and
 * install-windows.ps1, which carries an identical line): an exclusive
 * (FileShare None) handle on `<status>.lock`, held in a global for as long
 * as the PowerShell window lives and released by Windows the moment it
 * exits. "Is the window still alive?" is then "can't I open the lock?" —
 * which, unlike checking whether the recorded PID exists, can't be fooled
 * by Windows handing that PID to an unrelated process after the window
 * closed. Best-effort: if it can't be created, the PID check is the fallback.
 */
export const STATUS_LOCK_LINE =
  "try { $global:GrantedStatusLock = [System.IO.File]::Open(\"$StatusPath.lock\", 'OpenOrCreate', 'ReadWrite', 'None') } catch { }";

/** The lock file a status-reporting window holds open for its lifetime (see STATUS_LOCK_LINE). */
export function statusLockPath(statusPath: string): string {
  return `${statusPath}.lock`;
}

/**
 * A status file's content: install-windows.ps1's fields, plus the writing
 * window's pid, plus `closed` once resolveTaskStatus has found that window
 * gone without a done/error.
 */
export type StatusFile = InstallStatusEvent & { pid?: number; closed?: true };

/** parseInstallStatusJson, keeping buildTaskScript's `pid` too. */
export function parseStatusFile(raw: string): StatusFile | null {
  const status = parseInstallStatusJson(raw);
  if (!status) return null;
  try {
    const withoutBom = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
    const pid = (JSON.parse(withoutBom) as { pid?: unknown }).pid;
    return Number.isInteger(pid) && (pid as number) > 0 ? { ...status, pid: pid as number } : status;
  } catch {
    return status;
  }
}

export const TASK_WINDOW_CLOSED_MESSAGE = "Its PowerShell window was closed before it finished.";

/**
 * A "running" status whose window is gone means the user closed the window
 * (PowerShell died before it could write done/error) — report that as an
 * error now, flagged `closed` so callers can word it for their context,
 * rather than waiting out a timeout. `isAlive` is asked about the recorded
 * pid; the real check (openGranted.ts's isStatusWindowAlive) uses the
 * window's lock file and only falls back to the pid.
 */
export function resolveTaskStatus(status: StatusFile | null, isAlive: (pid: number) => boolean): StatusFile | null {
  if (status?.state === "running" && status.pid !== undefined && !isAlive(status.pid)) {
    return { state: "error", message: TASK_WINDOW_CLOSED_MESSAGE, pid: status.pid, closed: true };
  }
  return status;
}

/** finish: stop polling with this event. stillWaiting: keep polling, but tell the user it's taking a while. null: keep polling. */
export type PollDecision = { finish: InstallStatusEvent } | { stillWaiting: true } | null;

/**
 * One tick of a status-file poll (ipc.ts's pollStatusFile). `status` should
 * already have been through resolveTaskStatus, so a closed window arrives
 * here as an error flagged `closed` (reported with `closedMessage`).
 *
 * `waitWhileAlive` (the install): past overallTimeoutMs, a window that's
 * still alive is NOT given up on — a real Windows 11 run sat at a UAC
 * prompt for 12+ minutes, and giving up re-enabled the button, so a second
 * click started a concurrent install. Instead the caller shows a one-off
 * "still waiting — answer the prompt, or close the window to cancel" notice
 * (the window may also be genuinely stuck, and closing it is then the way
 * out). Without a pid to watch (an older install-windows.ps1), or for
 * tasks that keep their hard limit, overallTimeoutMs finishes with
 * timedOutMessage.
 */
export function decideStatusPoll(opts: {
  status: StatusFile | null;
  elapsedMs: number;
  sawRunning: boolean;
  startedTimeoutMs: number;
  overallTimeoutMs: number;
  notStartedMessage: string;
  timedOutMessage: string;
  closedMessage?: string;
  waitWhileAlive?: boolean;
}): PollDecision {
  const { status } = opts;
  if (status?.state === "done" || status?.state === "error") {
    const message = status.closed && opts.closedMessage ? opts.closedMessage : (status.message ?? null);
    return { finish: { state: status.state, message } };
  }
  if (!opts.sawRunning && opts.elapsedMs > opts.startedTimeoutMs) {
    return { finish: { state: "error", message: opts.notStartedMessage } };
  }
  if (opts.elapsedMs > opts.overallTimeoutMs) {
    if (opts.waitWhileAlive && status?.pid !== undefined) return { stillWaiting: true };
    return { finish: { state: "error", message: opts.timedOutMessage } };
  }
  return null;
}

/**
 * Whether a click should re-attach to the previous attempt's window rather
 * than start a new one: it's still running; or it finished "done" after the
 * poll gave up on it (when `acceptDone` — report that success instead of
 * redoing the work); or it hasn't reported anything yet but was launched
 * only moments ago (a slow, AV-heavy start — launching a second one now
 * would race it). A "running" status with no pid (an older script) can't
 * be checked for liveness, so it never re-attaches: that could wait on a
 * dead window forever.
 */
export function shouldReattach(
  status: StatusFile | null,
  opts: { launchedMsAgo: number; recentLaunchMs: number; acceptDone: boolean },
): boolean {
  if (status === null) return opts.launchedMsAgo < opts.recentLaunchMs;
  if (status.state === "running") return status.pid !== undefined;
  if (status.state === "done") return opts.acceptDone;
  return false;
}

/**
 * How to start scaffold/scripts/windows/granted-tray.ps1 — Granted running in
 * the background with a tray icon instead of in a console window the user
 * must keep open. Through `conhost.exe --headless`, NOT `powershell
 * -WindowStyle Hidden`: where Windows Terminal is the default console host
 * (Windows 11's default) the latter still opens a visible terminal window —
 * verified on a real Windows 11 25H2 machine; the former opens none. -STA
 * because the tray is Windows Forms. The Desktop/Start menu shortcuts
 * (shortcuts.ps1) launch it the same way, with -OpenBrowser.
 */
export function trayLaunchCommand(opts: {
  systemRoot: string;
  trayScript: string;
  port: number;
  statusPath?: string;
  openBrowser?: boolean;
}): { file: string; args: string[] } {
  const args = [
    "--headless",
    win32.join(opts.systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    "-NoProfile",
    "-STA",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    opts.trayScript,
    "-Port",
    String(opts.port),
  ];
  if (opts.statusPath) args.push("-StatusPath", opts.statusPath);
  if (opts.openBrowser) args.push("-OpenBrowser");
  return { file: win32.join(opts.systemRoot, "System32", "conhost.exe"), args };
}

/**
 * A Windows command line for `args` (the receiving program splits it the
 * standard way): an argument with whitespace — or an empty one — is
 * double-quoted. One containing a double quote is refused: a Windows path
 * can't contain one, and nothing passed here should.
 */
export function windowsArgLine(args: string[]): string {
  return args
    .map((s) => {
      if (s.includes('"')) throw new Error(`Refusing to pass an argument containing a double quote: ${s}`);
      return s === "" || /\s/.test(s) ? `"${s}"` : s;
    })
    .join(" ");
}

/**
 * The PowerShell -Command that starts `file args…` with Start-Process —
 * how the installer launches the tray. Not spawn(conhost) directly:
 * `conhost --headless` exits at once (code 0, nothing started) when given
 * real stdin/stdout handles, and Node always gives a spawned child some (NUL
 * for "ignore"); Start-Process goes through ShellExecute, which — like a
 * shortcut — gives none, and doesn't pass on this app's inheritable handles
 * either. Not `cmd /c start`: cmd would expand %VAR% (and !VAR!) inside the
 * paths even when quoted. Everything here is a single-quoted PowerShell
 * literal (psSingleQuoted), so nothing in a path is ever interpreted.
 * conhost.exe is a GUI-subsystem program, so no console — and no Windows
 * Terminal handoff — is created for it either way.
 */
export function startProcessCommand(file: string, args: string[]): string {
  return `Start-Process -FilePath ${psSingleQuoted(file)} -ArgumentList ${psSingleQuoted(windowsArgLine(args))}`;
}

/** shortcuts.ps1's JSON output → the shortcut paths it created (null if it isn't that shape). */
export function parseShortcutsOutput(stdout: string): string[] | null {
  try {
    const line = stdout.trim().split(/\r?\n/).filter(Boolean).pop() ?? "";
    const created = (JSON.parse(line) as { created?: unknown }).created;
    if (created === undefined || created === null) return [];
    const list = Array.isArray(created) ? created : [created]; // PS 5.1 can flatten a 1-item array
    return list.every((p) => typeof p === "string") ? (list as string[]) : null;
  } catch {
    return null;
  }
}

/** A fresh, unique status-file path for one "Open Granted" step (see newInstallStatusPath). */
export function newTaskStatusPath(task: string): string {
  return join(tmpdir(), `granted-${task}-status-${randomUUID()}.json`);
}

/**
 * The port Granted's `npm run dev` serves on: 3000 (Next's default, what the
 * README documents) unless GRANTED_PORT overrides it — which lets the
 * end-to-end tests run on a machine where a real Granted is already up.
 */
export function grantedPort(envValue: string | undefined): number {
  const n = Number(envValue);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : 3000;
}

/**
 * Whether an HTTP response body is Granted's own page — the app's <title> is
 * "<brand> — federal funding intelligence for everyone". Checked before
 * opening the browser so that some OTHER app already holding port 3000 is
 * never presented as Granted. (Granted's own dev error page doesn't match
 * either — callers word their messages to allow for that.)
 */
export function looksLikeGranted(html: string): boolean {
  return /federal funding intelligence/i.test(html);
}
