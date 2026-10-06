/**
 * Scrubs secrets and personal details out of error text before it is written
 * to the error log, and again before it leaves the computer in a problem
 * report. Pure and isomorphic (no Node or DOM imports): the server, the
 * browser and the tests all use this same function.
 *
 * What goes:
 *   - API keys and tokens (sk-…, sk-ant-…, AIza…, gsk_…, bearer tokens,
 *     `key=` query parameters, …): the static rules in sanitize-rules.json
 *   - email addresses
 *   - the user's home folder (→ ~) and user name
 *   - any extra literal secrets the caller passes (the server passes the
 *     values from .env.local and a key saved in Settings)
 *
 * Order: literal secrets first (so a secret that happens to contain a path
 * or an @ is still removed whole), then the home folder, then the static
 * rules, then the bare user name.
 */
import RULES_FILE from "./sanitize-rules.json";

export interface SanitizeRule {
  name: string;
  pattern: string;
  flags: string;
  replacement: string;
}

export interface SanitizeSettings {
  /** Env var names whose values are secrets whatever they look like. */
  secretEnvName: string;
  /** Env var names that hold ordinary settings (URLs, model names…): never redacted for merely LOOKING like a token. */
  settingEnvName: string;
  /** A value that looks like a token (long, letters and digits, no spaces). */
  tokenLikeValue: string;
  /** Hosts that are never redacted from URLs (the public provider APIs, GitHub…), with their subdomains. */
  publicHosts: string[];
  rules: SanitizeRule[];
}

export const SANITIZE_SETTINGS: SanitizeSettings = RULES_FILE;
export const SANITIZE_RULES: readonly SanitizeRule[] = RULES_FILE.rules;

export interface SanitizeContext {
  /** The user's home folder (os.homedir()); replaced with "~" wherever it appears, with either slash. */
  home?: string | null;
  /** The user's login name; replaced with "[user]" wherever it appears as a whole word. */
  user?: string | null;
  /** Literal secret values (from .env.local, a saved key, …); replaced with "[redacted]". */
  secrets?: readonly string[];
  /** Private hostnames (a self-hosted provider's base URL…); replaced with "[private-host]". See privateHosts(). */
  hosts?: readonly string[];
}

export const PRIVATE_HOST = "[private-host]";

export const REDACTED = "[redacted]";
export const USER_PLACEHOLDER = "[user]";
/** Shorter values are too likely to be ordinary words to redact on sight. */
export const MIN_SECRET_LENGTH = 6;
export const MIN_USER_LENGTH = 3;

const COMPILED = SANITIZE_RULES.map((r) => ({ re: new RegExp(r.pattern, `g${r.flags}`), replacement: r.replacement }));

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * A home folder as a pattern: either slash between its parts (and doubled
 * backslashes, as in JSON), case-insensitive, and not matching a longer
 * folder name that merely starts with it (C:\Users\kurt must not eat
 * C:\Users\kurtis).
 */
export function homePattern(home: string): string | null {
  const parts = home.replace(/[\\/]+$/, "").split(/[\\/]+/);
  if (parts.filter(Boolean).length < 2) return null; // "/", "C:\" or a bare name: too broad
  return `${parts.map(escapeRegExp).join("[\\\\/]+")}(?![A-Za-z0-9_\\-])`;
}

/** The bare user name as a whole word: `$1` keeps the character before it. */
export function userPattern(user: string): string | null {
  const u = user.trim();
  if (u.length < MIN_USER_LENGTH) return null;
  return `(^|[^A-Za-z0-9_])${escapeRegExp(u)}(?![A-Za-z0-9_])`;
}

/** Secrets worth matching literally, longest first (so a secret containing another goes whole). */
export function usableSecrets(secrets: readonly string[] | undefined): string[] {
  const seen = new Set<string>();
  for (const s of secrets ?? []) {
    const v = typeof s === "string" ? s.trim() : "";
    if (v.length >= MIN_SECRET_LENGTH) seen.add(v);
  }
  return Array.from(seen).sort((a, b) => b.length - a.length);
}

/** A hostname as a whole name: `$1` keeps the character before it; a longer name it is only part of doesn't match. */
export function hostPattern(host: string): string {
  return String.raw`(^|[^A-Za-z0-9.\-])` + escapeRegExp(host) + String.raw`(?![A-Za-z0-9\-]|\.[A-Za-z0-9])`;
}

function usableHosts(hosts: readonly string[] | undefined): string[] {
  const out = (hosts ?? []).map((h) => (typeof h === "string" ? h.trim().toLowerCase() : "")).filter((h) => h.length >= 3);
  return Array.from(new Set(out)).sort((a, b) => b.length - a.length);
}

/** Loopback hosts: never private information. */
export function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  return h === "localhost" || h === "::1" || h === "0.0.0.0" || /^127\.\d+\.\d+\.\d+$/.test(h);
}

/**
 * The hosts in these URLs (base URLs from .env.local and Settings) that say
 * something about the user's network: not loopback, and not a well-known
 * public service (publicHosts, or a subdomain of one).
 */
export function privateHosts(urls: readonly unknown[], publicHosts: readonly string[] = SANITIZE_SETTINGS.publicHosts): string[] {
  const out = new Set<string>();
  for (const u of urls) {
    if (typeof u !== "string" || !u.trim()) continue;
    let host: string;
    try {
      host = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(u.trim()) ? u.trim() : `http://${u.trim()}`).hostname.toLowerCase();
    } catch {
      continue;
    }
    host = host.replace(/^\[|\]$/g, "");
    if (!host || isLoopbackHost(host)) continue;
    if (publicHosts.some((p) => host === p || host.endsWith(`.${p}`))) continue;
    out.add(host);
  }
  return Array.from(out);
}

/** Sanitizes one piece of text. Never throws: if anything goes wrong, nothing of the input is returned. */
export function sanitize(text: unknown, ctx: SanitizeContext = {}): string {
  try {
    let out = typeof text === "string" ? text : text == null ? "" : String(text);
    if (!out) return out;
    for (const secret of usableSecrets(ctx.secrets)) out = out.split(secret).join(REDACTED);
    for (const host of usableHosts(ctx.hosts)) out = out.replace(new RegExp(hostPattern(host), "gi"), `$1${PRIVATE_HOST}`);
    const home = ctx.home ? homePattern(ctx.home) : null;
    if (home) out = out.replace(new RegExp(home, "gi"), "~");
    for (const { re, replacement } of COMPILED) out = out.replace(re, replacement);
    const user = ctx.user ? userPattern(ctx.user) : null;
    if (user) out = out.replace(new RegExp(user, "gi"), `$1${USER_PLACEHOLDER}`);
    return out;
  } catch {
    return "[could not be sanitized]";
  }
}

/** Sanitizes every string in a plain JSON-like value (objects, arrays), leaving other values as they are. */
export function sanitizeDeep<T>(value: T, ctx: SanitizeContext = {}): T {
  if (typeof value === "string") return sanitize(value, ctx) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => sanitizeDeep(v, ctx)) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = sanitizeDeep(v, ctx);
    return out as T;
  }
  return value;
}
