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
