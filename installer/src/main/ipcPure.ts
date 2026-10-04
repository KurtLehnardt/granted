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
import { join } from "node:path";
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
 * otherwise looks identical (nothing ever writes done/error). Everything
 * interpolated is single-quoted (psSingleQuoted), so a `$` or backtick in a
 * path is taken literally. `command` is only ever a fixed string chosen by
 * the main process, never user input.
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

/** A status file's content: install-windows.ps1's fields, plus the window's pid when buildTaskScript wrote it. */
export type StatusFile = InstallStatusEvent & { pid?: number };

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
 * A "running" status whose window process is gone means the user closed the
 * window (PowerShell died before it could write done/error) — report that
 * as an error now, rather than waiting out a timeout of up to two hours.
 */
export function resolveTaskStatus(status: StatusFile | null, isAlive: (pid: number) => boolean): StatusFile | null {
  if (status?.state === "running" && status.pid !== undefined && !isAlive(status.pid)) {
    return { state: "error", message: TASK_WINDOW_CLOSED_MESSAGE, pid: status.pid };
  }
  return status;
}

/**
 * One tick of a status-file poll (ipc.ts's pollStatusFile): the event to
 * finish with, or null to keep waiting. `status` should already have been
 * through resolveTaskStatus, so a closed window arrives here as an error.
 *
 * The overall timeout only applies when there's no pid to watch (a status
 * file from an older install-windows.ps1). While a window that reports its
 * pid is alive, it's genuinely still working — a real Windows 11 run sat at
 * a UAC prompt for 12+ minutes — so giving up would be wrong, and worse:
 * it re-enabled the button, and a second click started a concurrent
 * install. Closing the window is how a user cancels.
 */
export function decideStatusPoll(opts: {
  status: StatusFile | null;
  elapsedMs: number;
  sawRunning: boolean;
  startedTimeoutMs: number;
  overallTimeoutMs: number;
  notStartedMessage: string;
  timedOutMessage: string;
}): InstallStatusEvent | null {
  const { status } = opts;
  if (status?.state === "done" || status?.state === "error") return { state: status.state, message: status.message ?? null };
  if (!opts.sawRunning && status?.state !== "running" && opts.elapsedMs > opts.startedTimeoutMs) {
    return { state: "error", message: opts.notStartedMessage };
  }
  if (opts.elapsedMs > opts.overallTimeoutMs && status?.pid === undefined) {
    return { state: "error", message: opts.timedOutMessage };
  }
  return null;
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
