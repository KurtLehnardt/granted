/**
 * The per-user error log: one JSON object per line in
 *   %LOCALAPPDATA%\Granted\logs\errors.jsonl   (Windows)
 *   ~/.granted/logs/errors.jsonl                (elsewhere)
 * next to the tray's server-<port>.log. GRANTED_LOG_DIR overrides the folder
 * (tests); so does GRANTED_SETTINGS_PATH (logs/ next to that settings file).
 *
 * Rotates at ~1 MB, keeping 3 files (errors.jsonl, errors.1.jsonl,
 * errors.2.jsonl). Every function here swallows its own failures: logging an
 * error must never become a second error.
 *
 * Server-only (node:fs). Entries arrive here already sanitized.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const LOG_FILE_NAME = "errors.jsonl";
export const MAX_LOG_BYTES = 1_000_000;
export const KEEP_LOG_FILES = 3;

export interface ErrorLogEntry {
  /** Correlation id shown to the user (E-XXXXXX). */
  id: string;
  /** ISO time. */
  time: string;
  /** Granted's version. */
  version: string;
  /** e.g. "win32 10.0.26200 x64". */
  platform: string;
  /** What failed: "search", "llm-provider", "corpus-refresh", "client", … */
  area: string;
  message: string;
  /** A short stack (a few frames), if there was one. */
  stack?: string;
  /** Where it was caught. */
  source: "server" | "client";
  /** HTTP status, for a failed API request. */
  status?: number;
  /** The API route or page it happened on. */
  path?: string;
  /** Dedupe key: an entry with the same key isn't logged twice. */
  key?: string;
}

export interface StoreOptions {
  dir?: string;
  maxBytes?: number;
  keep?: number;
}

export function errorLogDir(env: Record<string, string | undefined> = process.env): string {
  if (env["GRANTED_LOG_DIR"]) return env["GRANTED_LOG_DIR"];
  if (env["GRANTED_SETTINGS_PATH"]) return path.join(path.dirname(env["GRANTED_SETTINGS_PATH"]), "logs");
  // Under node:test with no override: never the real log.
  if (env["NODE_TEST_CONTEXT"]) return path.join(os.tmpdir(), `granted-test-logs-${process.pid}`);
  const base = env["LOCALAPPDATA"] ? path.join(env["LOCALAPPDATA"], "Granted") : path.join(os.homedir(), ".granted");
  return path.join(base, "logs");
}

/** errors.jsonl, errors.1.jsonl, errors.2.jsonl… (0 = the current file). */
export function logFileName(index: number): string {
  return index === 0 ? LOG_FILE_NAME : LOG_FILE_NAME.replace(/\.jsonl$/, `.${index}.jsonl`);
}

/** The log files, oldest first. */
export function logFiles(opts: StoreOptions = {}): string[] {
  const dir = opts.dir ?? errorLogDir();
  const keep = opts.keep ?? KEEP_LOG_FILES;
  const files: string[] = [];
  for (let i = keep - 1; i >= 0; i--) files.push(path.join(dir, logFileName(i)));
  return files;
}

function rotateIfNeeded(dir: string, incoming: number, maxBytes: number, keep: number): void {
  let size: number;
  try {
    size = fs.statSync(path.join(dir, logFileName(0))).size;
  } catch {
    return; // no file yet
  }
  if (size + incoming <= maxBytes) return;
  try {
    fs.rmSync(path.join(dir, logFileName(keep - 1)), { force: true });
  } catch {
    /* best effort */
  }
  for (let i = keep - 2; i >= 0; i--) {
    try {
      fs.renameSync(path.join(dir, logFileName(i)), path.join(dir, logFileName(i + 1)));
    } catch {
      /* missing, or briefly locked: carry on */
    }
  }
}

/** Appends one entry (rotating first if it would pass the size limit). Returns false if it couldn't be written. Never throws. */
export function appendErrorEntry(entry: ErrorLogEntry, opts: StoreOptions = {}): boolean {
  try {
    const dir = opts.dir ?? errorLogDir();
    const line = `${JSON.stringify(entry)}\n`;
    fs.mkdirSync(dir, { recursive: true });
    rotateIfNeeded(dir, Buffer.byteLength(line), opts.maxBytes ?? MAX_LOG_BYTES, opts.keep ?? KEEP_LOG_FILES);
    fs.appendFileSync(path.join(dir, logFileName(0)), line, "utf8");
    return true;
  } catch {
    return false;
  }
}

function parseLine(line: string): ErrorLogEntry | null {
  if (!line.trim()) return null;
  try {
    const e = JSON.parse(line) as Partial<ErrorLogEntry>;
    if (!e || typeof e !== "object" || typeof e.message !== "string" || typeof e.id !== "string") return null;
    return {
      id: e.id,
      time: typeof e.time === "string" ? e.time : "",
      version: typeof e.version === "string" ? e.version : "",
      platform: typeof e.platform === "string" ? e.platform : "",
      area: typeof e.area === "string" ? e.area : "unknown",
      message: e.message,
      source: e.source === "client" ? "client" : "server",
      ...(typeof e.stack === "string" ? { stack: e.stack } : {}),
      ...(typeof e.status === "number" ? { status: e.status } : {}),
      ...(typeof e.path === "string" ? { path: e.path } : {}),
      ...(typeof e.key === "string" ? { key: e.key } : {}),
    };
  } catch {
    return null; // a torn or hand-edited line
  }
}

/** Every entry still on disk, oldest first. Never throws (an unreadable log reads as empty). */
export function readErrorEntries(opts: StoreOptions = {}): ErrorLogEntry[] {
  const out: ErrorLogEntry[] = [];
  for (const file of logFiles(opts)) {
    let text: string;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const line of text.split(/\r?\n/)) {
      const e = parseLine(line);
      if (e) out.push(e);
    }
  }
  return out;
}

/** Deletes every log file. Returns false if one couldn't be deleted. Never throws. */
export function clearErrorLog(opts: StoreOptions = {}): boolean {
  let ok = true;
  for (const file of logFiles(opts)) {
    try {
      fs.rmSync(file, { force: true });
    } catch {
      ok = false;
    }
  }
  return ok;
}
