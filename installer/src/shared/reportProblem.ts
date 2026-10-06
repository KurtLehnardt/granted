/**
 * "Report this problem" for the installer: a pre-filled GitHub "new issue"
 * link, opened in the user's own browser. They review it and submit it with
 * their own GitHub account; the installer holds no GitHub token (one shipped
 * in an app can be extracted and abused) and sends nothing itself.
 *
 * The installer doesn't depend on scaffold/, so the sanitizing rules are a
 * MIRROR of scaffold/lib/errorLog/sanitize-rules.json, applied the same way as
 * scaffold/lib/errorLog/sanitize.ts. src/main/__tests__/reportProblem.test.ts
 * fails if this copy drifts from that file (or from the tray's copy in
 * scaffold/scripts/windows/report-problem.ps1).
 *
 * Dependency-free (no Node/Electron/DOM imports), like the rest of src/shared.
 */

export interface SanitizeRule {
  name: string;
  pattern: string;
  flags: string;
  replacement: string;
}

export interface SanitizeSettings {
  secretEnvName: string;
  settingEnvName: string;
  tokenLikeValue: string;
  publicHosts: string[];
  rules: SanitizeRule[];
}

// MIRROR of scaffold/lib/errorLog/sanitize-rules.json (all but "$comment") -- keep identical.
export const SANITIZE_SETTINGS: SanitizeSettings = {
  "secretEnvName": "(^|_)(API_?KEY|KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?)$",
  "settingEnvName": "(_URL|_MODEL|_PROVIDER|_MODE|_DIMENSIONS|_PORT|_HOST)$|^(SEARCH|NEXT_PUBLIC|LLM|LOCAL|OLLAMA)_",
  "tokenLikeValue": "^(?=.*[0-9])(?=.*[A-Za-z])[^\\s]{16,}$",
  "publicHosts": ["api.anthropic.com","api.openai.com","generativelanguage.googleapis.com","openrouter.ai","api.groq.com","api.mistral.ai","api.x.ai","api.together.xyz","api.deepseek.com","api.fireworks.ai","github.com","api.github.com","huggingface.co","registry.npmjs.org","nodejs.org","aka.ms"],
  "rules": [
    {"name":"anthropic-key","pattern":"sk-ant-[A-Za-z0-9_\\-]{6,}","flags":"","replacement":"[redacted-key]"},
    {"name":"sk-key","pattern":"\\bsk-[A-Za-z0-9_\\-]{12,}","flags":"","replacement":"[redacted-key]"},
    {"name":"google-key","pattern":"AIza[0-9A-Za-z_\\-]{20,}","flags":"","replacement":"[redacted-key]"},
    {"name":"groq-key","pattern":"\\bgsk_[A-Za-z0-9]{12,}","flags":"","replacement":"[redacted-key]"},
    {"name":"xai-key","pattern":"\\bxai-[A-Za-z0-9]{20,}","flags":"","replacement":"[redacted-key]"},
    {"name":"huggingface-token","pattern":"\\bhf_[A-Za-z0-9]{20,}","flags":"","replacement":"[redacted-key]"},
    {"name":"github-token","pattern":"\\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})","flags":"","replacement":"[redacted-key]"},
    {"name":"bearer-token","pattern":"(\\bbearer\\s+)[A-Za-z0-9._~+/=\\-]{6,}","flags":"i","replacement":"$1[redacted]"},
    {"name":"basic-auth-header","pattern":"(\\bbasic\\s+)[A-Za-z0-9+/=]{12,}","flags":"i","replacement":"$1[redacted]"},
    {"name":"authorization-header","pattern":"(\\b(?:proxy-)?authorization[\"']?\\s*[:=]\\s*[\"']?(?:(?:token|apikey|api-key|key|bearer|basic|digest)\\s+)?)(?!(?:token|apikey|api-key|key|bearer|basic|digest)(?:\\s|$))[^\\s\"'&,;}\\[]{4,}","flags":"i","replacement":"$1[redacted]"},
    {"name":"url-credentials","pattern":"(\\b[a-z][a-z0-9+.\\-]{0,30}://)[^/\\s:@\"'<>]{1,256}:[^/\\s@\"'<>]{1,256}@","flags":"i","replacement":"$1[redacted]@"},
    {"name":"key-query-param","pattern":"([?&;](?:key|api_key|apikey|api-key|access_token|token|auth|sig|signature|password|secret)=)[^&\\s\"'#<>]+","flags":"i","replacement":"$1[redacted]"},
    {"name":"key-header-or-field","pattern":"(\\b(?:x-api-key|x-goog-api-key|api[_\\-]?key|api[_\\-]?secret|access[_\\-]?token|refresh[_\\-]?token|auth[_\\-]?token|id[_\\-]?token|client[_\\-]?secret|token|secret|password|passwd)[\"']?\\s*[:=]\\s*[\"']?)[^\\s\"'&,;}\\[]{4,}","flags":"i","replacement":"$1[redacted]"},
    {"name":"env-secret-assignment","pattern":"(\\b[A-Z0-9_]{0,60}(?:_KEY|_TOKEN|_SECRET|_PASSWORD|_PASS)\\s*=\\s*)[^\\s\"';,&]+","flags":"","replacement":"$1[redacted]"},
    {"name":"email","pattern":"[A-Za-z0-9._%+\\-]{1,64}@(?:[A-Za-z0-9\\-]{1,63}\\.){1,8}[A-Za-z]{2,24}\\b","flags":"","replacement":"[email]"},
    {"name":"private-network-url-host","pattern":"(\\b[a-z][a-z0-9+.\\-]{0,30}://)[A-Za-z0-9\\-.]{1,200}\\.(?:local|lan|internal|intranet|corp|home|localdomain)\\b","flags":"i","replacement":"$1[private-host]"},
    {"name":"private-ipv4","pattern":"\\b(?:10(?:\\.\\d{1,3}){3}|192\\.168(?:\\.\\d{1,3}){2}|172\\.(?:1[6-9]|2\\d|3[01])(?:\\.\\d{1,3}){2})\\b","flags":"","replacement":"[private-host]"},
    {"name":"windows-home","pattern":"\\b[A-Za-z]:[\\\\/]+(?:Users|Documents and Settings)[\\\\/]+[^\\\\/\\s\"'<>|:*?]+(?:(?: [^\\\\/\\s\"'<>|:*?]+){1,4}(?=[\\\\/]))?","flags":"i","replacement":"~"},
    {"name":"mac-home","pattern":"/Users/[^/\\s\"'<>:]+","flags":"","replacement":"~"},
    {"name":"linux-home","pattern":"/home/[^/\\s\"'<>:]+","flags":"","replacement":"~"},
    {"name":"onedrive-organization","pattern":"(\\bOneDrive) - [^\\\\/\"'<>|:*?\\r\\n]{1,100}?(?=[\\\\/\"'<>|:*?\\r\\n]|$)","flags":"","replacement":"$1"}
  ]
};

export const SANITIZE_RULES: readonly SanitizeRule[] = SANITIZE_SETTINGS.rules;

export interface SanitizeContext {
  home?: string | null;
  user?: string | null;
  secrets?: readonly string[];
  /** Private hostnames (from base URLs in .env.local); replaced with "[private-host]". */
  hosts?: readonly string[];
}

const COMPILED = SANITIZE_RULES.map((r) => ({ re: new RegExp(r.pattern, `g${r.flags}`), replacement: r.replacement }));

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function homePattern(home: string): string | null {
  const parts = home.replace(/[\\/]+$/, "").split(/[\\/]+/);
  if (parts.filter(Boolean).length < 2) return null;
  return parts.map(escapeRegExp).join(String.raw`[\\/]+`) + String.raw`(?![A-Za-z0-9_\-])`;
}

function hostPattern(host: string): string {
  return String.raw`(^|[^A-Za-z0-9.\-])` + escapeRegExp(host) + String.raw`(?![A-Za-z0-9\-]|\.[A-Za-z0-9])`;
}

/** Same as scaffold's sanitize(): literal secrets, private hosts, the home folder, the rules, then the user name. Never throws. */
export function sanitize(text: unknown, ctx: SanitizeContext = {}): string {
  try {
    let out = typeof text === "string" ? text : text == null ? "" : String(text);
    if (!out) return out;
    const secrets = Array.from(new Set((ctx.secrets ?? []).map((s) => (typeof s === "string" ? s.trim() : "")).filter((s) => s.length >= 6)));
    secrets.sort((a, b) => b.length - a.length);
    for (const secret of secrets) out = out.split(secret).join("[redacted]");
    const hosts = Array.from(new Set((ctx.hosts ?? []).map((h) => (typeof h === "string" ? h.trim().toLowerCase() : "")).filter((h) => h.length >= 3)));
    hosts.sort((a, b) => b.length - a.length);
    for (const host of hosts) out = out.replace(new RegExp(hostPattern(host), "gi"), "$1[private-host]");
    const home = ctx.home ? homePattern(ctx.home) : null;
    if (home) out = out.replace(new RegExp(home, "gi"), "~");
    for (const { re, replacement } of COMPILED) out = out.replace(re, replacement);
    const user = ctx.user?.trim();
    if (user && user.length >= 3) out = out.replace(new RegExp(`(^|[^A-Za-z0-9_])${escapeRegExp(user)}(?![A-Za-z0-9_])`, "gi"), "$1[user]");
    return out;
  } catch {
    return "[could not be sanitized]";
  }
}

const SECRET_NAME = new RegExp(SANITIZE_SETTINGS.secretEnvName, "i");
const SETTING_NAME = new RegExp(SANITIZE_SETTINGS.settingEnvName, "i");
const TOKEN_LIKE = new RegExp(SANITIZE_SETTINGS.tokenLikeValue);

/** NAME=value pairs of a .env-style file. */
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

/** Same rule as isSecretEnv() in scaffold/lib/errorLog/server.ts. */
export function isSecretEnv(name: string, value: string): boolean {
  if (SECRET_NAME.test(name)) return !/^(true|false|\d+)$/i.test(value);
  return !SETTING_NAME.test(name) && TOKEN_LIKE.test(value);
}

/** The values in a .env-style file worth redacting. */
export function envFileSecrets(text: string): string[] {
  return envFileEntries(text)
    .filter((e) => isSecretEnv(e.name, e.value))
    .map((e) => e.value);
}

/** Same as privateHosts() in scaffold/lib/errorLog/sanitize.ts. */
export function privateHosts(urls: readonly unknown[]): string[] {
  const out = new Set<string>();
  for (const u of urls) {
    if (typeof u !== "string" || !u.trim()) continue;
    let host: string;
    try {
      host = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(u.trim()) ? u.trim() : `http://${u.trim()}`).hostname.toLowerCase().replace(/^\[|\]$/g, "");
    } catch {
      continue;
    }
    if (!host || host === "localhost" || host === "::1" || host === "0.0.0.0" || /^127\.\d+\.\d+\.\d+$/.test(host)) continue;
    if (SANITIZE_SETTINGS.publicHosts.some((p) => host === p || host.endsWith(`.${p}`))) continue;
    out.add(host);
  }
  return Array.from(out);
}

export const ISSUE_NEW_URL = "https://github.com/KurtLehnardt/granted/issues/new";
export const ISSUE_TEMPLATE = "bug_report.yml";
export const MAX_ISSUE_URL_LENGTH = 7000;

export interface InstallerIssueInput {
  /** The error the installer showed. */
  message: string;
  /** The installer's version. */
  version: string;
  /** e.g. "win32 10.0.26200 x64". */
  os: string;
  /** Which screen it happened on. */
  where: string;
  sanitize?: SanitizeContext;
  maxLength?: number;
}

function cut(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, Math.max(0, max - 3))}...` : s;
}

const PRIVACY_NOTE =
  "(API keys, email addresses and your user folder were removed automatically. Please check nothing private is left before you submit.)";

/** The issue form's fields (ids from .github/ISSUE_TEMPLATE/bug_report.yml); "What happened" is left for the user. */
function fields(input: InstallerIssueInput, message: string): Record<string, string> {
  return {
    environment: [
      `- Granted installer version: ${input.version}`,
      `- Operating system: ${input.os}`,
      "- Model provider: not set up yet (installer)",
      "- Search mode: not set up yet (installer)",
      `- Reported from: installer (${input.where})`,
    ].join("\n"),
    "recent-errors": [PRIVACY_NOTE, "", message.replace(/`{3,}/g, "'''")].join("\n"),
  };
}

/**
 * The pre-filled link to the issue FORM (it applies the bug label itself; a
 * labels= parameter is dropped for anyone without triage rights): everything
 * sanitized, and never longer than maxLength.
 */
export function buildInstallerIssueUrl(input: InstallerIssueInput): string {
  const max = input.maxLength ?? MAX_ISSUE_URL_LENGTH;
  const ctx = input.sanitize;
  const clean = { ...input, version: sanitize(input.version, ctx), os: sanitize(input.os, ctx), where: sanitize(input.where, ctx) };
  const message = sanitize(input.message, ctx) || "The installer showed an error.";
  const firstLine = (message.split(/\r?\n/).find((l) => l.trim()) ?? "").trim();
  const base = `${ISSUE_NEW_URL}?template=${encodeURIComponent(ISSUE_TEMPLATE)}&title=${encodeURIComponent(`Problem (installer): ${cut(firstLine, 80)}`)}`;
  const link = (m: string): string =>
    base +
    Object.entries(fields(clean, m))
      .map(([k, v]) => `&${k}=${encodeURIComponent(v)}`)
      .join("");
  for (let len = message.length; len > 0; len = Math.floor(len * 0.7)) {
    const url = link(cut(message, len));
    if (url.length <= max) return url;
  }
  return base.length <= max ? base : `${ISSUE_NEW_URL}?template=${ISSUE_TEMPLATE}`;
}
