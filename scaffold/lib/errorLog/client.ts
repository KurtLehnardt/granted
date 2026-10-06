/**
 * The browser half of error logging: reportClientError() sends an error the
 * page hit to the local error log (POST /api/logs, loopback-only) and returns
 * the correlation id to show next to it. Fire-and-forget: it never throws,
 * never waits, and a server that can't be reached just means the entry is
 * missing — the id and the "Report this problem" link still work.
 *
 * An error the SERVER already logged carries its id (`errorId` on the thrown
 * error, from the API's response): that id is reused and nothing is sent twice.
 */
import { isErrorId, newErrorId } from "./errorId";
import { buildIssueUrl } from "./issueUrl";
import { sanitize } from "./sanitize";

/** Per page load: a page stuck in an error loop stops reporting after this many. */
export const MAX_CLIENT_REPORTS = 30;
/** The same error again within this long reuses the first one's id instead of logging again. */
export const DUPLICATE_WINDOW_MS = 5000;

const recent = new Map<string, { id: string; at: number }>();
let reports = 0;

export function resetClientReportsForTests(): void {
  recent.clear();
  reports = 0;
}

/** An Error carrying the id of the server's log entry for it. */
export type ErrorWithId = Error & { errorId?: string };

export function errorWithId(message: string, errorId: unknown): ErrorWithId {
  const e: ErrorWithId = new Error(message);
  if (isErrorId(errorId)) e.errorId = errorId;
  return e;
}

export function errorIdOf(err: unknown): string | undefined {
  const id = err && typeof err === "object" ? (err as { errorId?: unknown }).errorId : undefined;
  return isErrorId(id) ? id : undefined;
}

export function clientMessageOf(err: unknown): string {
  if (err instanceof Error) return err.name && err.name !== "Error" ? `${err.name}: ${err.message}` : err.message || "Unknown error";
  if (typeof err === "string") return err || "Unknown error";
  if (err && typeof err === "object" && typeof (err as { message?: unknown }).message === "string") return (err as { message: string }).message;
  try {
    return JSON.stringify(err) ?? String(err);
  } catch {
    return String(err);
  }
}

export interface ReportOptions {
  id?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

/** Logs an error the page hit and returns its correlation id. Never throws. */
export function reportClientError(area: string, err: unknown, opts: ReportOptions = {}): string {
  const already = errorIdOf(err);
  if (already) return already;
  const id = isErrorId(opts.id) ? opts.id : newErrorId();
  try {
    // Sanitized here too (the server does it again with this computer's own secrets and paths).
    const message = sanitize(clientMessageOf(err)).slice(0, 2000);
    const stack = err instanceof Error && err.stack ? sanitize(err.stack).slice(0, 4000) : undefined;
    const now = (opts.now ?? Date.now)();
    const sig = `${area}|${message}`;
    const seen = recent.get(sig);
    if (seen && now - seen.at < DUPLICATE_WINDOW_MS) return seen.id;
    recent.set(sig, { id, at: now });
    if (reports >= MAX_CLIENT_REPORTS) return id;
    reports++;
    const f = opts.fetchImpl ?? (typeof fetch === "function" ? fetch : undefined);
    if (!f) return id;
    const path = typeof window !== "undefined" ? window.location?.pathname : undefined;
    void f("/api/logs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "log", entry: { id, area, message, stack, path } }),
      keepalive: true,
    }).catch(() => {});
  } catch {
    /* reporting is best-effort; the id is still shown */
  }
  return id;
}

/**
 * A report link built in the browser, from just this error: what the page
 * links to until the server's fuller one (with the recent log, the version
 * and the provider) arrives, or if the server can't be reached at all.
 */
export function browserIssueUrl(opts: { errorId?: string; area?: string; message?: string }): string {
  const os = typeof navigator !== "undefined" ? navigator.userAgent : undefined;
  return buildIssueUrl({
    errorId: opts.errorId,
    source: "app",
    context: { os },
    errors: opts.message ? [{ id: opts.errorId, area: opts.area, message: opts.message, time: new Date().toISOString() }] : [],
  }).url;
}
