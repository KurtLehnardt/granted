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
import { readLlmConfig } from "../llm/config";
import { newErrorId, isErrorId } from "./errorId";
import { sanitize, type SanitizeContext } from "./sanitize";
import { appendErrorEntry, readErrorEntries, type ErrorLogEntry } from "./store";

export const MAX_MESSAGE_CHARS = 2000;
export const MAX_STACK_LINES = 8;
export const MAX_STACK_CHARS = 1500;

/**
 * Env names whose values are secrets whatever they look like: OPENAI_API_KEY,
 * GITHUB_TOKEN, CLIENT_SECRET, DB_PASSWORD… (anchored at the end, so Windows'
 * own SESSIONNAME=Console and the like don't get "Console" redacted everywhere).
 */
const SECRET_NAME = /(^|_)(API_?KEY|KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?)$/i;
/** A value that looks like a token even under an innocent name (long, letters and digits, no spaces). */
const TOKEN_LIKE = /^(?=.*[0-9])(?=.*[A-Za-z])[^\s]{16,}$/;

/** Values in a .env-style file worth redacting. */
export function envFileSecrets(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (!value) continue;
    if (SECRET_NAME.test(m[1]) || TOKEN_LIKE.test(value)) out.push(value);
  }
  return out;
}

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

/**
 * What this computer's errors must be scrubbed of: the home folder, the user
 * name, the values in scaffold/.env.local, secret-named environment
 * variables, and a key saved in Settings.
 */
export function serverSanitizeContext(cwd: string = process.cwd(), env: Record<string, string | undefined> = process.env): SanitizeContext {
  const secrets: string[] = [];
  safe(() => secrets.push(...envFileSecrets(fs.readFileSync(path.join(cwd, ".env.local"), "utf8"))), undefined);
  for (const [name, value] of Object.entries(env)) {
    if (value && SECRET_NAME.test(name) && !/^(true|false|\d+)$/i.test(value)) secrets.push(value);
  }
  safe(() => {
    const cfg = readLlmConfig();
    if (cfg.cloud?.keySource.type === "inline") secrets.push(cfg.cloud.keySource.key);
    if (cfg.anthropicApiKey) secrets.push(cfg.anthropicApiKey);
  }, undefined);
  return {
    home: safe(() => os.homedir(), null),
    user: safe(() => os.userInfo().username, null) ?? env["USERNAME"] ?? env["USER"] ?? null,
    secrets,
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

/** Writes `err` to the error log and returns its correlation id. Never throws. */
export function logError(area: string, err: unknown, opts: LogErrorOptions = {}): string {
  const id = isErrorId(opts.id) ? opts.id : newErrorId();
  try {
    if (opts.once) {
      const existing = readErrorEntries().slice(-200).find((e) => e.key === opts.once);
      if (existing) return existing.id;
    }
    const base = serverSanitizeContext();
    const ctx: SanitizeContext = opts.secrets ? { ...base, secrets: [...(base.secrets ?? []), ...opts.secrets] } : base;
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
      ...(opts.once ? { key: sanitize(opts.once.slice(0, 200), ctx) } : {}),
    };
    appendErrorEntry(entry);
  } catch {
    /* logging must never become a second failure */
  }
  return id;
}
