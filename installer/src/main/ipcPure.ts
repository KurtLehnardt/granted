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
import { join, posix, win32 } from "node:path";
import { INSTALL_ONE_LINERS } from "../shared/ipc";
import type { InstallStatusEvent, InstallVersionPlan, OpenIn } from "../shared/ipc";

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
 * Single-quoted POSIX shell string literal — the bash/sh equivalent of
 * psSingleQuoted, used the same way (and for the same reason): nothing
 * inside single quotes is expanded (`$`, backticks, globs), regardless of
 * what the value contains. There's no escape character inside single
 * quotes in sh, so a literal single quote is produced by closing the
 * quoted string, emitting an escaped one outside it, and reopening —
 * the standard POSIX trick.
 */
export function shSingleQuoted(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
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
 * Whether `npm run setup:local` got all the way through. Today it ends by
 * writing LLM_PROVIDER=ollama once the chat model is pulled; search runs on
 * Granted's built-in model, so there is nothing else to check. Older
 * setup:local runs also pointed EMBEDDINGS_BASE_URL at Ollama and re-embedded
 * the corpus with it; for those the env lines alone aren't proof, because the
 * re-embed could still fail after they were written, leaving vectors that don't
 * match. That re-embed's last write is data/local/corpus-meta.json, stamped
 * with the model it used, so when EMBEDDINGS_BASE_URL is set that file must
 * exist and match too.
 */
export function envIsLocalConfigured(text: string, localCorpusMetaJson: string | null): boolean {
  if (currentEnvValue(text, "LLM_PROVIDER").toLowerCase() !== "ollama") return false;
  if (currentEnvValue(text, "EMBEDDINGS_BASE_URL") === "") return true;
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
 * Whether the user already chose a model provider in Granted's Settings
 * (scaffold/data/local/llm-config.json, written by Settings → Model). A saved
 * cloud provider (Gemini, Groq, OpenRouter, the Claude proxy and so on) with a
 * key source, or Local, means Granted can score without anything in
 * .env.local, so the installer shouldn't ask for keys again. Mirrors the
 * shapes scaffold/lib/llm/config.ts accepts, including the older
 * `anthropicApiKey` field.
 */
export function settingsHasProvider(llmConfigJson: string | null): boolean {
  if (!llmConfigJson) return false;
  try {
    const raw = llmConfigJson.charCodeAt(0) === 0xfeff ? llmConfigJson.slice(1) : llmConfigJson;
    const parsed = JSON.parse(raw) as {
      provider?: unknown;
      cloud?: { providerId?: unknown; keySource?: { type?: unknown } } | null;
      anthropicApiKey?: unknown;
    };
    if (!parsed || typeof parsed !== "object") return false;
    if (parsed.provider === "ollama") return true;
    const cloud = parsed.cloud;
    const hasCloud =
      !!cloud &&
      typeof cloud === "object" &&
      typeof cloud.providerId === "string" &&
      cloud.providerId !== "" &&
      !!cloud.keySource &&
      typeof cloud.keySource === "object" &&
      typeof cloud.keySource.type === "string";
    const hasLegacy = typeof parsed.anthropicApiKey === "string" && parsed.anthropicApiKey.length > 0;
    return (parsed.provider === undefined || parsed.provider === "cloud" || parsed.provider === "anthropic") && (hasCloud || hasLegacy);
  } catch {
    return false;
  }
}

/** What `applyApiKeys` reports as missing when neither scoring key is set: one of OPENAI_API_KEY or ANTHROPIC_API_KEY. */
export const SCORING_KEY = "OPENAI_API_KEY or ANTHROPIC_API_KEY";

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
): { text: string; missing: string[]; invalid: string[] } {
  // A key the user typed that the app would refuse (scaffold/lib/llm/
  // providers.ts) is rejected here, with its name — not saved, only to fail
  // at the first search as "No cloud provider is configured".
  const invalid: string[] = [];
  if (keys.OPENAI_API_KEY.trim() && !isOpenAiKeyFormat(keys.OPENAI_API_KEY.trim())) invalid.push("OPENAI_API_KEY");
  if (keys.ANTHROPIC_API_KEY.trim() && !isAnthropicKeyFormat(keys.ANTHROPIC_API_KEY.trim())) invalid.push("ANTHROPIC_API_KEY");
  let out = text;
  for (const [key, raw] of Object.entries(keys)) {
    const value = raw.trim();
    if (value !== "") out = upsertEnv(out, key, value);
  }
  // Search needs no key: it runs on Granted's built-in model on this computer
  // (an OpenAI key, when present, is used for search instead, as before). What
  // a search does need is something to score the matches, and one key from
  // either OpenAI or Anthropic (Claude) is enough for that
  // (scaffold/lib/llm/config.ts resolveCloudConfig). Other providers are set up
  // in Settings → Model once Granted is open.
  const hasScoringKey =
    isOpenAiKeyFormat(currentEnvValue(out, "OPENAI_API_KEY")) || isAnthropicKeyFormat(currentEnvValue(out, "ANTHROPIC_API_KEY"));
  const missing = hasScoringKey ? [] : [SCORING_KEY];
  return { text: out, missing, invalid };
}

// The app's own key-shape rules (scaffold/lib/llm/providers.ts
// isValidOpenAiKeyFormat / isValidAnthropicKeyFormat), mirrored — installer/
// doesn't depend on scaffold/ — so the installer never accepts a key the app
// would then refuse. Tested against the same examples.
const STRICT_KEY_LENGTH = { min: 20, max: 200 } as const;

export function isOpenAiKeyFormat(key: string): boolean {
  return key.length >= STRICT_KEY_LENGTH.min && key.length <= STRICT_KEY_LENGTH.max && !/\s/.test(key) && key.startsWith("sk-");
}

export function isAnthropicKeyFormat(key: string): boolean {
  return key.length >= STRICT_KEY_LENGTH.min && key.length <= STRICT_KEY_LENGTH.max && /^sk-ant-[A-Za-z0-9_-]+$/.test(key);
}

/**
 * Whether .env.local is ready for hosted (API-key) mode: a valid OpenAI or
 * Claude key to score with (see applyApiKeys), and NOT switched to a local
 * model. A `setup:local` that wrote LLM_PROVIDER=ollama but didn't finish must
 * still be offered the choice again, not started as-is.
 */
export function envHasHostedKeys(text: string): boolean {
  const provider = currentEnvValue(text, "LLM_PROVIDER").toLowerCase();
  const hasKey = isOpenAiKeyFormat(currentEnvValue(text, "OPENAI_API_KEY")) || isAnthropicKeyFormat(currentEnvValue(text, "ANTHROPIC_API_KEY"));
  return hasKey && (provider === "" || provider === "anthropic");
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
 * macOS's equivalent of statusLockPath: a DIRECTORY, not a file (see
 * install-macos.sh's own comment on STATUS_LOCK_DIR for why — no flock(1) to
 * rely on). `mkdir`'d right after $StatusPath is set, before anything else
 * runs, same position as STATUS_LOCK_LINE; removed in install-macos.sh's
 * EXIT trap, so — like the Windows file handle — it comes down the moment
 * that process ends, however it ends (except SIGKILL, which no trap can
 * catch). Must stay in sync with install-macos.sh's STATUS_LOCK_DIR — a test
 * checks.
 */
export function macStatusLockPath(statusPath: string): string {
  return `${statusPath}.lock.d`;
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
 * macOS's equivalent of trayLaunchCommand: how to start
 * scaffold/scripts/macos/granted-tray.sh — Granted running in the background
 * under a per-user LaunchAgent, with a menu-bar icon, instead of a process
 * tied to whoever started it.
 *
 * Run through `/bin/bash <script>` rather than the script's own shebang, for
 * the same reason install-macos.sh is: a file fetched or copied without its
 * executable bit still runs. There is no console-window dance to arrange
 * (launchd gives the server no terminal at all, and the menu-bar helper
 * detaches itself with nohup), so unlike Windows this needs no conhost and no
 * Start-Process — just the arguments.
 */
export function macTrayLaunchCommand(opts: {
  trayScript: string;
  port: number;
  statusPath?: string;
  openBrowser?: boolean;
}): { file: string; args: string[] } {
  const args = [opts.trayScript, "start", "--port", String(opts.port)];
  if (opts.statusPath) args.push("--status-path", opts.statusPath);
  if (opts.openBrowser) args.push("--open-browser");
  return { file: "/bin/bash", args };
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

/**
 * macOS's equivalent of the Windows shortcuts: how to run
 * scaffold/scripts/macos/applications-launcher.sh, which creates the per-user
 * ~/Applications/Granted.app and (only if asked) adds it to the Dock.
 *
 * Through `/bin/bash <script>` rather than the script's own shebang, for the
 * same reason macTrayLaunchCommand is: a file fetched or copied without its
 * executable bit still runs.
 *
 * The port is always passed, never left to the script's own default, because
 * the launcher bakes it into the bundle: an app started from Finder or the
 * Dock inherits none of the user's shell environment, so `GRANTED_PORT` would
 * not reach it at click time and the port it opens has to be decided here,
 * once, by whoever creates it.
 */
export function macLauncherCommand(opts: {
  launcherScript: string;
  port: number;
  addToDock: boolean;
}): { file: string; args: string[] } {
  const args = [opts.launcherScript, "install", "--port", String(opts.port)];
  if (opts.addToDock) args.push("--add-to-dock");
  return { file: "/bin/bash", args };
}

/**
 * What happened to the Dock entry: this run added it, it was already there,
 * the user didn't ask for one, or it couldn't be added (see
 * applications-launcher.sh's add_to_dock, which confirms the change by reading
 * the Dock's preferences back rather than trusting `defaults write`'s exit
 * code).
 */
export type DockState = "added" | "already" | "skipped" | "failed";

export interface LauncherOutput {
  /** The ~/Applications/Granted.app that was created, or null if it wasn't. */
  launcher: string | null;
  /** Whether the bundle got the converted .icns, or is showing the generic app icon. */
  icon: boolean;
  dock: DockState;
}

/**
 * applications-launcher.sh's JSON output → what it created (null if the output
 * isn't that shape at all). The counterpart of parseShortcutsOutput, and read
 * the same way: the LAST non-empty line, so anything a shell printed ahead of
 * it is ignored.
 */
export function parseLauncherOutput(stdout: string): LauncherOutput | null {
  try {
    const line = stdout.trim().split(/\r?\n/).filter(Boolean).pop() ?? "";
    const parsed = JSON.parse(line) as { launcher?: unknown; icon?: unknown; dock?: unknown };
    const launcher = parsed.launcher;
    if (launcher !== null && typeof launcher !== "string") return null;
    const dock = parsed.dock;
    if (dock !== "added" && dock !== "already" && dock !== "skipped" && dock !== "failed") return null;
    return { launcher: launcher ?? null, icon: parsed.icon === true, dock };
  } catch {
    return null;
  }
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

/**
 * The per-user settings file the trays, open-granted.ps1 and this installer
 * read and write: %LOCALAPPDATA%\Granted\settings.json on Windows,
 * ~/Library/Application Support/Granted/settings.json on macOS — the same two
 * paths scaffold/lib/appUpdate/install.ts's settingsPath() resolves, so the
 * app, the menu-bar helper and the installer share one file (and so the
 * `openIn` the installer saves is the one the menu-bar helper later reads).
 * GRANTED_SETTINGS_PATH overrides both, for tests.
 *
 * Each branch joins with the separator of the platform it describes —
 * `posix.join` for the macOS path, `win32.join` for the Windows one — never the
 * ambient `join`, which is whichever platform this process happens to be
 * running on. REGRESSION (CI): the macOS branch used plain `join`, so on the
 * windows-latest runner it returned
 * `\Users\a\Library\Application Support\Granted\settings.json` and the test
 * asserting the real path failed there while passing everywhere else.
 */
export function grantedSettingsPath(
  env: Record<string, string | undefined>,
  home: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (env["GRANTED_SETTINGS_PATH"]) return env["GRANTED_SETTINGS_PATH"];
  // LOCALAPPDATA before the platform check, so a Windows-path test runs on any OS.
  if (platform === "darwin" && !env["LOCALAPPDATA"]) {
    return posix.join(home, "Library", "Application Support", "Granted", "settings.json");
  }
  return win32.join(env["LOCALAPPDATA"] || win32.join(home, "AppData", "Local"), "Granted", "settings.json");
}

function parseSettingsObject(text: string | null): Record<string, unknown> {
  if (!text) return {};
  try {
    const parsed: unknown = JSON.parse(text.replace(/^﻿/, ""));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** The saved "open in" preference — its own window unless the file says browser (same rule as open-granted.ps1). */
export function parseOpenInSetting(text: string | null): OpenIn {
  return parseSettingsObject(text)["openIn"] === "browser" ? "browser" : "window";
}

/** The settings file's new contents with openIn set, keeping anything else in it. */
export function withOpenInSetting(text: string | null, openIn: OpenIn): string {
  return JSON.stringify({ ...parseSettingsObject(text), openIn });
}

/** open-granted.ps1's JSON output → how it opened Granted ("none": it left that to the caller), or null if unreadable. */
export function parseOpenGrantedOutput(stdout: string): "window" | "browser" | "none" | null {
  try {
    const line = stdout.trim().split(/\r?\n/).filter(Boolean).pop() ?? "";
    const openedIn = (JSON.parse(line) as { openedIn?: unknown }).openedIn;
    return openedIn === "window" || openedIn === "browser" || openedIn === "none" ? openedIn : null;
  } catch {
    return null;
  }
}

/** A release tag: v<major>.<minor>.<patch> (the only form install-windows.ps1's GRANTED_REF accepts). */
const RELEASE_TAG = /^v(\d+)\.(\d+)\.(\d+)$/;

export function parseReleaseTag(tag: string | null | undefined): [number, number, number] | null {
  const m = RELEASE_TAG.exec(tag ?? "");
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** Whether release tag `a` is newer than `b` (false if either isn't a release tag). */
export function isNewerRelease(a: string | null, b: string | null): boolean {
  const pa = parseReleaseTag(a);
  const pb = parseReleaseTag(b);
  if (!pa || !pb) return false;
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] > pb[i];
  return false;
}

/**
 * GitHub's "latest release" API response → its tag, if it's a published,
 * stable release tag (anything else — a draft, a prerelease, a tag like
 * "hackathon-deadline" — is not something to update to).
 */
export function parseLatestRelease(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const r = body as { tag_name?: unknown; draft?: unknown; prerelease?: unknown };
  if (r.draft === true || r.prerelease === true || typeof r.tag_name !== "string") return null;
  return parseReleaseTag(r.tag_name) ? r.tag_name : null;
}

/**
 * Which Granted to install: the release this installer was built for, or —
 * when the user ticked "check for updates" and a newer release exists —
 * that one. `ref` null = no pinned release (a development build): the
 * latest code on main, as the README's one-liner installs.
 */
export function chooseInstallRef(opts: {
  pinned: string | null;
  checkForUpdates: boolean;
  latest: string | null;
  checkFailed: boolean;
}): InstallVersionPlan {
  const { pinned, checkForUpdates, latest, checkFailed } = opts;
  if (!pinned) return { pinned: null, latest: null, ref: null, checkForUpdates: false, checkFailed: false };
  const newer = checkForUpdates && isNewerRelease(latest, pinned);
  return { pinned, latest: checkForUpdates ? latest : null, ref: newer ? latest : pinned, checkForUpdates, checkFailed: checkForUpdates && checkFailed };
}

/** The Windows one-liner for a release (or main, for null) — what's run, and what's copied to the clipboard. */
export function windowsInstallCommand(ref: string | null): string {
  if (ref === null) return "irm https://raw.githubusercontent.com/KurtLehnardt/granted/main/install-windows.ps1 | iex";
  if (!parseReleaseTag(ref)) throw new Error(`not a release tag: ${ref}`);
  return `$env:GRANTED_REF = '${ref}'; irm https://raw.githubusercontent.com/KurtLehnardt/granted/${ref}/install-windows.ps1 | iex`;
}

/**
 * The temp .ps1 the GUI runs in a console window: where to report status,
 * then the one-liner. (Never put on powershell.exe's command line itself —
 * see openInstallTerminal: Defender flags `-Command "irm … | iex"`.)
 */
export function buildWindowsInstallScript(statusPath: string, ref: string | null): string {
  return windowsInstallScriptFor(statusPath, windowsDownloadAndRun(installScriptUrl(ref), ref));
}

/** Where install-windows.ps1 for `ref` (null = main) is downloaded from. */
export function installScriptUrl(ref: string | null): string {
  if (ref !== null && !parseReleaseTag(ref)) throw new Error(`not a release tag: ${ref}`);
  return `https://raw.githubusercontent.com/KurtLehnardt/granted/${ref ?? "main"}/install-windows.ps1`;
}

/** Seconds to wait before each retry of the download (the first try is immediate). */
export const INSTALL_DOWNLOAD_RETRY_WAITS = [3, 6, 12, 20];

/**
 * What the GUI's install window runs: the one-liner's `irm … | iex`, but
 * downloading with retries first — a network hiccup (a VPN reconnecting, Wi-Fi
 * waking up: "The remote name could not be resolved: 'raw.githubusercontent.com'")
 * shouldn't fail the install — and, if GitHub still can't be reached, reporting
 * that plainly to the installer app (its status file) instead of leaving it to
 * guess at a security policy. The copy-paste one-liner (windowsInstallCommand)
 * stays the plain `irm | iex`.
 */
export function windowsDownloadAndRun(url: string, ref: string | null, waits: number[] = INSTALL_DOWNLOAD_RETRY_WAITS): string {
  if (ref !== null && !parseReleaseTag(ref)) throw new Error(`not a release tag: ${ref}`);
  const lines = [
    ...(ref ? [`$env:GRANTED_REF = '${ref}'`] : []),
    `[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12`,
    `$grantedInstaller = $null`,
    `$grantedError = $null`,
    `foreach ($wait in @(${[0, ...waits].join(", ")})) {`,
    `  if ($wait -gt 0) { Write-Host "Couldn't reach GitHub ($grantedError) -- trying again in $wait seconds..." -ForegroundColor Yellow; Start-Sleep -Seconds $wait }`,
    `  try { $grantedInstaller = Invoke-RestMethod -UseBasicParsing -Uri ${psSingleQuoted(url)}; break } catch { $grantedError = $_.Exception.Message }`,
    `}`,
    `if ($null -eq $grantedInstaller) {`,
    `  $grantedMessage = "Couldn't download the Granted installer from GitHub ($grantedError). Check your internet connection (and your VPN, if you use one), then click Try again."`,
    `  Set-Content -LiteralPath $env:GRANTED_STATUS_FILE -Value (@{ state = 'error'; message = $grantedMessage; pid = $PID } | ConvertTo-Json -Compress) -Encoding utf8`,
    `  Write-Host $grantedMessage -ForegroundColor Red`,
    `  exit 1`,
    `}`,
    `Invoke-Expression $grantedInstaller`,
  ];
  return lines.join("\r\n");
}

/** Seconds a successful install's window stays up (so "Installed" can be read) before closing itself. */
export const INSTALL_WINDOW_CLOSE_SECONDS = 5;

/**
 * The script around `command`: report to `statusPath`, run it, and then —
 * only if it reported "done" — close the window by itself after a few
 * seconds: the installer app takes it from there, and a leftover console
 * full of "Next steps" commands just confuses. On an error (or anything
 * else) the window stays open (-NoExit) so the message can be read.
 * [Environment]::Exit, not `exit`: under -NoExit, `exit` only ends this
 * script and leaves the window at a prompt.
 */
export function windowsInstallScriptFor(statusPath: string, command: string): string {
  const status = psSingleQuoted(statusPath);
  return [
    `$env:GRANTED_STATUS_FILE = ${status}`,
    command,
    // The window may stay open, and anything pasted into it later must not
    // report into this attempt's status file.
    `Remove-Item Env:GRANTED_STATUS_FILE -ErrorAction SilentlyContinue`,
    `$grantedStatus = $null`,
    // -ErrorAction Stop: if the download failed before the install wrote any
    // status, no second (misleading) red "path not found" error under the real one.
    `try { $grantedStatus = Get-Content -LiteralPath ${status} -Raw -ErrorAction Stop | ConvertFrom-Json } catch { }`,
    `if ($grantedStatus -and $grantedStatus.state -eq 'done') {`,
    `  Write-Host ""`,
    `  Write-Host "Installed. This window closes in ${INSTALL_WINDOW_CLOSE_SECONDS} seconds -- carry on in the Granted installer." -ForegroundColor Green`,
    `  Start-Sleep -Seconds ${INSTALL_WINDOW_CLOSE_SECONDS}`,
    `  [Environment]::Exit(0)`,
    `}`,
    ``,
  ].join("\r\n");
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

// ---------------------------------------------------------------------------
// The install escape hatch — macOS. Mirrors the Windows section above
// (buildWindowsInstallScript / windowsDownloadAndRun / windowsInstallScriptFor)
// exactly, in bash instead of PowerShell: a temp .sh the GUI runs in a new
// Terminal window via `do script`, reporting status the same way
// install-macos.sh itself does (write_status's {state,message,pid} shape —
// so parseInstallStatusJson reads both), with retried downloads and the same
// error wording. decideStatusPoll/shouldReattach need no macOS-specific
// logic at all: both already work purely off the StatusFile shape, never the
// platform that produced it.
// ---------------------------------------------------------------------------

/** Where install-macos.sh for `ref` (null = main) is downloaded from. */
export function macInstallScriptUrl(ref: string | null): string {
  if (ref !== null && !parseReleaseTag(ref)) throw new Error(`not a release tag: ${ref}`);
  return `https://raw.githubusercontent.com/KurtLehnardt/granted/${ref ?? "main"}/install-macos.sh`;
}

/**
 * The macOS one-liner for a release (or main, for null) — what's run, and
 * what's copied to the clipboard. `ref === null` is the only case the GUI
 * ever actually asks for today (macOS has no pinned-release build yet — see
 * ipc.ts's versionPlanner, unchanged by this), but this stays ref-aware, like
 * windowsInstallCommand, because install-macos.sh itself (below) supports
 * GRANTED_REF regardless of whether anything currently sets it this way.
 */
export function macInstallCommand(ref: string | null): string {
  if (ref === null) return INSTALL_ONE_LINERS.darwin;
  if (!parseReleaseTag(ref)) throw new Error(`not a release tag: ${ref}`);
  return `GRANTED_REF=${shSingleQuoted(ref)} bash -c "$(curl -fsSL https://raw.githubusercontent.com/KurtLehnardt/granted/${ref}/install-macos.sh)"`;
}

/**
 * The temp .sh the GUI runs in a new Terminal window: where to report
 * status, then the one-liner. Never put directly on osascript's command
 * line (same reasoning as Windows's temp .ps1 — see openInstallTerminal;
 * the macOS concern is escaping/robustness through AppleScript's own string
 * literal, not Defender).
 */
export function buildMacInstallScript(statusPath: string, ref: string | null): string {
  return macInstallScriptFor(statusPath, macDownloadAndRun(macInstallScriptUrl(ref), ref));
}

/**
 * What the GUI's install window runs: the one-liner's `bash -c "$(curl …)"`,
 * but downloading with retries first and reporting a plain failure to the
 * status file if GitHub still can't be reached after all of them — the
 * bash equivalent of windowsDownloadAndRun, same wait sequence
 * (INSTALL_DOWNLOAD_RETRY_WAITS) and the same error wording. `-fSL` (not
 * `-fsSL`): curl's own error text (on stderr, captured below) is the only
 * way this script learns *why* GitHub couldn't be reached, and `-s` would
 * suppress exactly that.
 */
export function macDownloadAndRun(url: string, ref: string | null, waits: number[] = INSTALL_DOWNLOAD_RETRY_WAITS): string {
  if (ref !== null && !parseReleaseTag(ref)) throw new Error(`not a release tag: ${ref}`);
  const waitList = [0, ...waits].join(" ");
  return [
    `GRANTED_INSTALLER=""`,
    `GRANTED_ERROR=""`,
    `for GRANTED_WAIT in ${waitList}; do`,
    `  if [ "$GRANTED_WAIT" -gt 0 ]; then`,
    `    echo "Couldn't reach GitHub ($GRANTED_ERROR) -- trying again in $GRANTED_WAIT seconds..."`,
    `    sleep "$GRANTED_WAIT"`,
    `  fi`,
    `  GRANTED_TMP="$(mktemp)"`,
    `  if GRANTED_CURL_ERR="$(curl -fSL -o "$GRANTED_TMP" ${shSingleQuoted(url)} 2>&1)"; then`,
    `    GRANTED_INSTALLER="$(cat "$GRANTED_TMP")"`,
    `    rm -f "$GRANTED_TMP"`,
    `    break`,
    `  else`,
    `    GRANTED_ERROR="$GRANTED_CURL_ERR"`,
    `    rm -f "$GRANTED_TMP"`,
    `  fi`,
    `done`,
    `if [ -z "$GRANTED_INSTALLER" ]; then`,
    `  GRANTED_MESSAGE="Couldn't download the Granted installer from GitHub ($GRANTED_ERROR). Check your internet connection (and your VPN, if you use one), then click Try again."`,
    `  GRANTED_ESCAPED="$(printf '%s' "$GRANTED_MESSAGE" | sed 's/\\\\/\\\\\\\\/g; s/"/\\"/g')"`,
    `  printf '{"state":"error","message":"%s","pid":%d}' "$GRANTED_ESCAPED" "$$" > "$GRANTED_STATUS_FILE" 2>/dev/null || true`,
    `  echo "$GRANTED_MESSAGE" >&2`,
    `  exit 1`,
    `fi`,
    ...(ref ? [`export GRANTED_REF=${shSingleQuoted(ref)}`] : []),
    `bash -c "$GRANTED_INSTALLER"`,
  ].join("\n");
}

/**
 * The AppleScript-driven close, run from inside the script itself (not a
 * wrapper watching from the main process) — chosen because it needed no new
 * seam in the already-running poll, and a real run confirmed it closes the
 * window cleanly with no "still running, close anyway?" prompt once nothing
 * is left to run after it (see ipc.ts's openInstallTerminal for the real
 * verification note). `|| true`: a window the user already closed by hand
 * must not turn this into a visible error.
 */
export const MAC_CLOSE_WINDOW_COMMAND = 'osascript -e \'tell application "Terminal" to close front window\' >/dev/null 2>&1 || true';

/**
 * The script around `command`: report to `statusPath`, run it, and then —
 * only if it reported "done" — close the window by itself after a few
 * seconds (INSTALL_WINDOW_CLOSE_SECONDS, shared with windowsInstallScriptFor
 * — the same pause, so "Installed" can be read either way). On an error (or
 * anything else) the window is left exactly as the script left it (bash
 * doesn't exit a Terminal tab on its own the way -NoExit keeps a PowerShell
 * window around; nothing here needs to force that), so the message stays
 * on screen. A plain substring check (not a JSON parse): the status file's
 * shape is entirely ours (buildMacInstallScript's own error write above,
 * or install-macos.sh's write_status), so it's always exactly
 * `"state":"done"` or not, with no need for a JSON parser in bash.
 */
export function macInstallScriptFor(statusPath: string, command: string): string {
  const status = shSingleQuoted(statusPath);
  return [
    `#!/usr/bin/env bash`,
    `export GRANTED_STATUS_FILE=${status}`,
    command,
    // The window may stay open, and anything pasted into it later must not
    // report into this attempt's status file.
    `unset GRANTED_STATUS_FILE`,
    `if [ -f ${status} ] && grep -q '"state":"done"' ${status} 2>/dev/null; then`,
    `  echo`,
    `  echo "Installed. This window closes in ${INSTALL_WINDOW_CLOSE_SECONDS} seconds -- carry on in the Granted installer."`,
    `  sleep ${INSTALL_WINDOW_CLOSE_SECONDS}`,
    `  ${MAC_CLOSE_WINDOW_COMMAND}`,
    `fi`,
    ``,
  ].join("\n");
}
