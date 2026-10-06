/**
 * logError(area, err): the one call every server-side failure path makes. It
 * sanitizes the error, writes it to the per-user error log (store.ts) and
 * returns the correlation id to show the user. It never throws and never
 * blocks the request on anything but a small synchronous file append.
 *
 * Server-only. Plain relative imports (no "@/"), so scripts run with
 * `node --import tsx` (scripts/refresh-corpus.mjs) can use it too.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { appVersion } from "../appUpdate/install";
import { readLlmConfig, resolveCloudApiKey, resolveCloudConfig } from "../llm/config";
import { expandHome } from "../llm/keySource";
import { newErrorId, isErrorId } from "./errorId";
import { privateHosts, sanitize, SANITIZE_SETTINGS, type SanitizeContext } from "./sanitize";
import { appendErrorEntry, errorLogDir, readErrorEntries, type ErrorLogEntry } from "./store";

export const MAX_MESSAGE_CHARS = 2000;
export const MAX_STACK_LINES = 8;
export const MAX_STACK_CHARS = 1500;

/** Env names whose values are secrets whatever they look like (OPENAI_API_KEY, GITHUB_TOKEN…): sanitize-rules.json. */
const SECRET_NAME = new RegExp(SANITIZE_SETTINGS.secretEnvName, "i");
/** Env names holding ordinary settings (OLLAMA_BASE_URL, LOCAL_LLM_MODEL, SEARCH_*…): not redacted for looking like a token. */
const SETTING_NAME = new RegExp(SANITIZE_SETTINGS.settingEnvName, "i");
/** A value that looks like a token even under an innocent name (long, letters and digits, no spaces). */
const TOKEN_LIKE = new RegExp(SANITIZE_SETTINGS.tokenLikeValue);
/** The fcc provider's default key file (lib/llm/providers.ts), redacted whether or not it's the configured source. */
export const FCC_DEFAULT_KEY_FILE = "~/.fcc/proxy_auth_token";

/** NAME=value pairs of a .env-style file (comments, blanks and quotes handled). */
export function envFileEntries(text: string): Array<{ name: string; value: string }> {
  const out: Array<{ name: string; value: string }> = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2].trim();
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) value = value.slice(1, -1);
    if (value) out.push({ name: m[1], value });
  }
  return out;
}

/** Whether a NAME=value is worth redacting: a secret-named variable, or a token-looking value under a name that isn't an ordinary setting. */
export function isSecretEnv(name: string, value: string): boolean {
  if (SECRET_NAME.test(name)) return !/^(true|false|\d+)$/i.test(value);
  return !SETTING_NAME.test(name) && TOKEN_LIKE.test(value);
}

/** Values in a .env-style file worth redacting. */
export function envFileSecrets(text: string): string[] {
  return envFileEntries(text)
    .filter((e) => isSecretEnv(e.name, e.value))
    .map((e) => e.value);
}

/** URL-ish values in a .env-style file / the environment (base URLs: their private hosts get redacted). */
export function envUrls(entries: Array<{ name: string; value: string }>): string[] {
  return entries.filter((e) => /_URL$/i.test(e.name) || /^https?:\/\//i.test(e.value)).map((e) => e.value);
}

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

/** Every non-empty line of a small key file (a multi-line file's other lines may be keys too). */
function keyFileLines(file: string): string[] {
  return safe(() => {
    const p = expandHome(file);
    const stat = fs.statSync(p);
    if (!stat.isFile() || stat.size > 8 * 1024) return [];
    return fs.readFileSync(p, "utf8").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  }, []);
}

/**
 * What this computer's errors must be scrubbed of: the home folder, the user
 * name, the secrets in scaffold/.env.local, secret-named environment
 * variables, the cloud key in use WHATEVER its source (saved inline, any env
 * var, a key file — and fcc's default key file), and the private hosts of
 * configured base URLs.
 */
export function serverSanitizeContext(cwd: string = process.cwd(), env: Record<string, string | undefined> = process.env): SanitizeContext {
  const secrets: string[] = [];
  const urls: string[] = [];
  const envLocal = safe(() => envFileEntries(fs.readFileSync(path.join(cwd, ".env.local"), "utf8")), []);
  secrets.push(...envLocal.filter((e) => isSecretEnv(e.name, e.value)).map((e) => e.value));
  urls.push(...envUrls(envLocal));
  for (const [name, value] of Object.entries(env)) {
    if (!value) continue;
    if (SECRET_NAME.test(name) && !/^(true|false|\d+)$/i.test(value)) secrets.push(value);
    if (/_BASE_URL$/i.test(name)) urls.push(value);
  }
  safe(() => {
    const file = readLlmConfig();
    const cfg = resolveCloudConfig(file);
    if (cfg) {
      const resolved = resolveCloudApiKey(cfg).key;
      if (resolved) secrets.push(resolved);
      if (cfg.keySource.type === "inline") secrets.push(cfg.keySource.key);
      if (cfg.keySource.type === "env" && env[cfg.keySource.name]) secrets.push(env[cfg.keySource.name]!);
      if (cfg.keySource.type === "file") secrets.push(...keyFileLines(cfg.keySource.path));
      if (cfg.baseUrl) urls.push(cfg.baseUrl);
    }
    if (file.anthropicApiKey) secrets.push(file.anthropicApiKey);
  }, undefined);
  secrets.push(...keyFileLines(FCC_DEFAULT_KEY_FILE));
  return {
    home: safe(() => os.homedir(), null),
    user: safe(() => os.userInfo().username, null) ?? env["USERNAME"] ?? env["USER"] ?? null,
    secrets,
    hosts: privateHosts(urls),
  };
}

export function platformLabel(): string {
  return safe(() => `${process.platform} ${os.release()} ${process.arch}`, process.platform);
}

/** A readable one-line-ish message for anything thrown. */
export function messageOf(err: unknown): string {
  let msg: string;
  if (err instanceof Error) msg = err.name && err.name !== "Error" ? `${err.name}: ${err.message}` : err.message;
  else if (typeof err === "string") msg = err;
  else if (err && typeof err === "object" && typeof (err as { message?: unknown }).message === "string") msg = (err as { message: string }).message;
  else msg = safe(() => JSON.stringify(err) ?? String(err), String(err));
  msg = msg || "Unknown error";
  // The causes underneath ("fetch failed" says little; "connect ECONNREFUSED …" says what happened).
  const seen = new Set<unknown>([err]);
  let cause = err && typeof err === "object" ? (err as { cause?: unknown }).cause : undefined;
  for (let i = 0; cause != null && i < 4 && !seen.has(cause); i++) {
    seen.add(cause);
    const c = cause instanceof Error ? (cause.name && cause.name !== "Error" ? `${cause.name}: ${cause.message}` : cause.message) : typeof cause === "string" ? cause : "";
    const code = cause && typeof cause === "object" && typeof (cause as { code?: unknown }).code === "string" ? (cause as { code: string }).code : "";
    if (c || code) msg += ` <- ${c || code}${code && c && !c.includes(code) ? ` (${code})` : ""}`;
    cause = cause && typeof cause === "object" ? (cause as { cause?: unknown }).cause : undefined;
  }
  return msg.length > MAX_MESSAGE_CHARS ? `${msg.slice(0, MAX_MESSAGE_CHARS - 1)}…` : msg;
}

/** The first few stack frames (V8 "    at …" or Firefox/Safari "fn@url:line"), without the message line. */
export function shortStack(stack: unknown): string | undefined {
  if (typeof stack !== "string" || !stack.trim()) return undefined;
  const lines = stack.split(/\r?\n/);
  let frames = lines.filter((l) => /^\s*at\s/.test(l));
  if (frames.length === 0) frames = lines.filter((l) => /@.*:\d+/.test(l));
  if (frames.length === 0) return undefined;
  const out = frames.slice(0, MAX_STACK_LINES).map((l) => l.trim()).join("\n");
  return out.length > MAX_STACK_CHARS ? `${out.slice(0, MAX_STACK_CHARS - 1)}…` : out;
}

function stackOf(err: unknown): string | undefined {
  if (err instanceof Error) return err.stack;
  if (err && typeof err === "object" && typeof (err as { stack?: unknown }).stack === "string") return (err as { stack: string }).stack;
  return undefined;
}

const AREA = /^[a-z0-9][a-z0-9-]{0,39}$/;

export function cleanArea(area: unknown): string {
  return typeof area === "string" && AREA.test(area) ? area : "unknown";
}

export interface LogErrorOptions {
  /** Reuse this correlation id (e.g. the one the browser already showed); otherwise a new one. */
  id?: string;
  status?: number;
  /** The API route or page. */
  path?: string;
  /** Log this at most once: an entry with the same key already in the log is not added again (its id is returned). */
  once?: string;
  source?: "server" | "client";
  /** A stack to use instead of the error's own (the browser sends its own). */
  stack?: string | null;
  /** More literal secrets to scrub (e.g. a key being tested that isn't saved anywhere yet). */
  secrets?: readonly string[];
}

/**
 * `once` keys already logged (sanitized key -> id), kept in memory: read from
 * the log the first time it's needed in this process, then just added to — so
 * a page polling every few seconds doesn't re-read the whole log each time.
 * (On globalThis, so every Next route bundle shares one.)
 */
const ONCE = Symbol.for("granted.errorLog.once");
type OnceCache = { loadedFrom: string | null; keys: Map<string, string> };
function onceCache(): OnceCache {
  const g = globalThis as unknown as Record<symbol, OnceCache | undefined>;
  g[ONCE] ??= { loadedFrom: null, keys: new Map() };
  return g[ONCE]!;
}

/** Forget the remembered `once` keys (after the log is cleared, and in tests). */
export function resetOnceCache(): void {
  const c = onceCache();
  c.loadedFrom = null;
  c.keys.clear();
}

function onceKeys(): Map<string, string> {
  const c = onceCache();
  const dir = errorLogDir();
  if (c.loadedFrom !== dir) {
    c.keys.clear();
    for (const e of readErrorEntries()) if (e.key) c.keys.set(e.key, e.id);
    c.loadedFrom = dir;
  }
  return c.keys;
}

/** Writes `err` to the error log and returns its correlation id. Never throws. */
export function logError(area: string, err: unknown, opts: LogErrorOptions = {}): string {
  const id = isErrorId(opts.id) ? opts.id : newErrorId();
  try {
    const base = serverSanitizeContext();
    const ctx: SanitizeContext = opts.secrets ? { ...base, secrets: [...(base.secrets ?? []), ...opts.secrets] } : base;
    const key = opts.once ? sanitize(opts.once.slice(0, 200), ctx) : undefined;
    if (key) {
      const existing = onceKeys().get(key);
      if (existing) return existing;
    }
    const stack = shortStack(opts.stack === undefined ? stackOf(err) : opts.stack);
    const entry: ErrorLogEntry = {
      id,
      time: new Date().toISOString(),
      version: safe(() => appVersion(), "0.0.0"),
      platform: platformLabel(),
      area: cleanArea(area),
      message: sanitize(messageOf(err), ctx),
      source: opts.source ?? "server",
      ...(stack ? { stack: sanitize(stack, ctx) } : {}),
      ...(typeof opts.status === "number" ? { status: opts.status } : {}),
      ...(opts.path ? { path: sanitize(opts.path.slice(0, 200), ctx) } : {}),
      ...(key ? { key } : {}),
    };
    if (appendErrorEntry(entry) && key) onceKeys().set(key, id);
  } catch {
    /* logging must never become a second failure */
  }
  return id;
}
