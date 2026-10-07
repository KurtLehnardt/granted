/**
 * "Report a problem": a pre-filled GitHub "new issue" link the user opens in
 * their own browser, reviews, and submits with their own GitHub account.
 * Granted itself never holds a GitHub token (one shipped in the app could be
 * extracted and abused), and nothing is sent anywhere until the user clicks
 * Submit on GitHub.
 *
 * Pure and isomorphic. Everything that goes into the link is sanitized here
 * again, even though the log was sanitized when it was written.
 *
 * The link opens the repo's issue FORM (.github/ISSUE_TEMPLATE/bug_report.yml,
 * which applies the "bug" label itself: a `labels=` parameter only works for
 * people with triage rights, so it would be dropped for everyone else) with
 * its fields filled in by id: error-id, environment and recent-errors.
 * "What happened" is left for the user.
 */
import { sanitize, type SanitizeContext } from "./sanitize";

export const ISSUE_NEW_URL = "https://github.com/KurtLehnardt/granted/issues/new";
/** The issue form the link opens, and the ids of the fields it fills (they must match bug_report.yml). */
export const ISSUE_TEMPLATE = "bug_report.yml";
export const ISSUE_FIELDS = { errorId: "error-id", environment: "environment", recentErrors: "recent-errors" } as const;
/** Browsers and GitHub cope with longer, but some proxies and GitHub's own redirect don't: stay well under 8 KB. */
export const MAX_ISSUE_URL_LENGTH = 7000;
/** At most this many errors are considered for one report (the full log is "Copy log"). */
export const MAX_ISSUE_ERRORS = 20;

export interface IssueError {
  id?: string;
  time?: string;
  area?: string;
  message: string;
  stack?: string;
}

export interface IssueContext {
  version?: string;
  os?: string;
  /** "ollama", "cloud (anthropic)", … — the provider TYPE, never a key. */
  provider?: string;
  /** Which embeddings search uses: "builtin", "openai", "custom". */
  searchMode?: string;
}

export interface IssueInput {
  /** The error the user clicked "Report this problem" on, if any: it goes first, and in the title. */
  errorId?: string;
  /** Where the report comes from: "app", "installer", "tray". */
  source?: string;
  context: IssueContext;
  /** Newest first. */
  errors: IssueError[];
  sanitize?: SanitizeContext;
  maxLength?: number;
}

export interface IssueLink {
  url: string;
  /** Whether the asked-about error (errorId) was among the errors given. */
  found: boolean;
  /** How many errors made it into the link. */
  included: number;
  /** How many were left out to keep the link short. */
  omitted: number;
}

const enc = encodeURIComponent;

/** Keeps a fenced code block intact whatever the text contains. */
function unfence(s: string): string {
  return s.replace(/`{3,}/g, "'''");
}

function cut(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, Math.max(0, max - 1))}…` : s;
}

function firstLine(s: string): string {
  return (s.split(/\r?\n/).find((l) => l.trim()) ?? "").trim();
}

export function issueTitle(input: Pick<IssueInput, "errorId" | "errors" | "source">, ctx?: SanitizeContext): string {
  // Only ever the asked-about error's own message: never another one's, if it isn't in the log.
  const primary = input.errorId ? input.errors.find((e) => e.id === input.errorId) : undefined;
  const where = input.source && input.source !== "app" ? ` (${input.source})` : "";
  const id = input.errorId ? ` [${sanitize(input.errorId, ctx)}]` : "";
  if (primary) {
    const what = cut(firstLine(sanitize(primary.message, ctx)), 80);
    return `Problem${where}: ${what || "an error"}${id}`;
  }
  return `Problem report${where}${id}`;
}

function formatError(e: IssueError, ctx: SanitizeContext | undefined, limits: { message: number; stack: number }): string {
  const head = [e.time, e.area, e.id].filter(Boolean).map((s) => sanitize(s, ctx)).join(" · ");
  const lines = [head ? `[${head}]` : "", cut(sanitize(e.message, ctx), limits.message)];
  if (e.stack && limits.stack > 0) lines.push(cut(sanitize(e.stack, ctx), limits.stack));
  return unfence(lines.filter(Boolean).join("\n"));
}

export const PRIVACY_NOTE =
  "(API keys, email addresses and your user folder were removed automatically. Please check nothing private is left before you submit.)";

/** The form's field values (by field id). */
export function issueFields(
  input: IssueInput,
  errors: IssueError[],
  omitted: number,
  limits: { message: number; stack: number } = { message: 1000, stack: 600 },
): Record<string, string> {
  const ctx = input.sanitize;
  const c = input.context;
  const s = (v: string | undefined): string => (v ? sanitize(v, ctx) : "unknown");
  const environment = [
    `- Granted version: ${s(c.version)}`,
    `- Operating system: ${s(c.os)}`,
    `- Model provider: ${s(c.provider)}`,
    `- Search mode: ${s(c.searchMode)}`,
    `- Reported from: ${s(input.source ?? "app")}`,
  ].join("\n");
  const recent = [PRIVACY_NOTE, ""];
  if (errors.length === 0) recent.push("No errors were recorded.");
  else recent.push(errors.map((e) => formatError(e, ctx, limits)).join("\n\n"));
  if (omitted > 0) {
    recent.push(
      "",
      `${omitted} more error${omitted === 1 ? " was" : "s were"} left out to keep this link short. ` +
        "Settings → Problems & logs → Copy log copies the whole log, if you'd like to paste it here.",
    );
  }
  return {
    [ISSUE_FIELDS.errorId]: input.errorId ? sanitize(input.errorId, ctx) : "",
    [ISSUE_FIELDS.environment]: environment,
    [ISSUE_FIELDS.recentErrors]: recent.join("\n"),
  };
}

export function issueLink(title: string, fields: Record<string, string>): string {
  const params = [`template=${enc(ISSUE_TEMPLATE)}`, `title=${enc(title)}`];
  for (const [k, v] of Object.entries(fields)) if (v) params.push(`${k}=${enc(v)}`);
  return `${ISSUE_NEW_URL}?${params.join("&")}`;
}

/** The errors to report: the clicked one first, then the rest newest first. */
function ordered(input: IssueInput): IssueError[] {
  const all = input.errors.slice(0, MAX_ISSUE_ERRORS);
  if (!input.errorId) return all;
  const i = all.findIndex((e) => e.id === input.errorId);
  if (i === 0) return all;
  if (i > 0) return [all[i], ...all.slice(0, i), ...all.slice(i + 1)];
  // Not in the most recent ones: look further back before giving up on it.
  const older = input.errors.find((e) => e.id === input.errorId);
  return older ? [older, ...all.slice(0, MAX_ISSUE_ERRORS - 1)] : all;
}

/**
 * The link, as long as it fits under maxLength: as many errors as fit (the
 * oldest are dropped first), then a shorter stack and message for the last
 * one, and finally no errors at all — never a link that is too long.
 */
export function buildIssueUrl(input: IssueInput): IssueLink {
  const max = input.maxLength ?? MAX_ISSUE_URL_LENGTH;
  const title = issueTitle(input, input.sanitize);
  const errors = ordered(input);
  const total = Math.max(errors.length, input.errors.length);
  const found = !!input.errorId && input.errors.some((e) => e.id === input.errorId);

  for (let n = errors.length; n >= 1; n--) {
    const url = issueLink(title, issueFields(input, errors.slice(0, n), total - n));
    if (url.length <= max) return { url, included: n, omitted: total - n, found };
  }
  if (errors.length > 0) {
    for (const limits of [
      { message: 1000, stack: 0 },
      { message: 400, stack: 0 },
      { message: 120, stack: 0 },
    ]) {
      const url = issueLink(title, issueFields(input, errors.slice(0, 1), total - 1, limits));
      if (url.length <= max) return { url, included: 1, omitted: total - 1, found };
    }
  }
  const bare = issueLink(title, issueFields(input, [], total));
  if (bare.length <= max) return { url: bare, included: 0, omitted: total, found };
  return { url: issueLink(cut(title, 60), {}), included: 0, omitted: total, found };
}
