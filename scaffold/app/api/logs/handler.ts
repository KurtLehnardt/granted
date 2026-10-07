import { spawn } from "node:child_process";
import { NextResponse } from "next/server";
import { isLoopbackRequest } from "@/lib/corpus/loopback";
import { rateLimit } from "@/lib/security/rateLimit";
import { issueContext } from "@/lib/errorLog/context";
import { isErrorId } from "@/lib/errorLog/errorId";
import { buildIssueUrl, type IssueContext } from "@/lib/errorLog/issueUrl";
import { sanitize, type SanitizeContext } from "@/lib/errorLog/sanitize";
import { cleanArea, logError, resetOnceCache, serverSanitizeContext, type LogErrorOptions } from "@/lib/errorLog/server";
import { clearErrorLog, errorLogDir, readErrorEntries, type ErrorLogEntry } from "@/lib/errorLog/store";

// GET  /api/logs                 the Problems & logs summary: counts, the last few errors, the report link
// GET  /api/logs?issue=E-XXXXXX  the same, with the report link pre-filled for that error
// GET  /api/logs?format=text     the whole log as text (Copy log)
// POST /api/logs                 { action: "log", entry } — an error the page hit (window.onerror,
//                                unhandled rejections, error boundaries, failed requests)
//                                { action: "clear" } | { action: "open-folder" }
// Loopback-only: the log is this computer's, and the page that writes to it must be Granted's own.

/** A browser error report is small; anything bigger is not one. */
export const MAX_LOG_BODY_BYTES = 16 * 1024;
/** The summary shows this many of the newest errors. */
export const RECENT_SHOWN = 5;
/** "Recent" = within this long. */
export const RECENT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** A page stuck in an error loop can't flood the log. */
export const CLIENT_LOG_LIMIT = { limit: 60, windowMs: 60_000 };

type Req = { headers: { get(name: string): string | null }; url: string };

export type LogsDeps = {
  isLoopbackRequest: typeof isLoopbackRequest;
  readEntries: () => ErrorLogEntry[];
  clearLog: () => boolean;
  logError: (area: string, err: unknown, opts?: LogErrorOptions) => string;
  issueContext: () => IssueContext;
  sanitizeContext: () => SanitizeContext;
  logDir: () => string;
  openFolder: (dir: string) => boolean;
  platform: NodeJS.Platform;
  allowClientLog: () => boolean;
  now: () => number;
};

/** Windows: an Explorer window on the folder, via explorer.exe. macOS: a Finder
 *  window, via `open` -- present on every real macOS install, unlike Linux,
 *  which has no single file-manager launcher guaranteed across distros
 *  (including headless boxes), so it still falls back to the page showing
 *  the path instead. */
function openFolderInFileManager(dir: string): boolean {
  const [cmd, args]: [string, string[]] = process.platform === "win32" ? ["explorer.exe", [dir]] : ["open", [dir]];
  try {
    const child = spawn(cmd, args, { detached: true, stdio: "ignore", windowsHide: false });
    child.on("error", () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

const REAL_DEPS: LogsDeps = {
  isLoopbackRequest,
  readEntries: () => readErrorEntries(),
  clearLog: () => {
    const ok = clearErrorLog();
    resetOnceCache();
    return ok;
  },
  logError,
  issueContext,
  sanitizeContext: () => serverSanitizeContext(),
  logDir: () => errorLogDir(),
  openFolder: openFolderInFileManager,
  platform: process.platform,
  allowClientLog: () => rateLimit("api-logs-client", CLIENT_LOG_LIMIT).ok,
  now: () => Date.now(),
};

const forbidden = () => NextResponse.json({ error: "Only available from this computer" }, { status: 403 });

/** An entry as it leaves the server: sanitized again (with today's secrets), and without the dedupe key. */
function present(e: ErrorLogEntry, ctx: SanitizeContext) {
  return {
    id: e.id,
    time: e.time,
    area: e.area,
    source: e.source,
    message: sanitize(e.message, ctx),
    ...(e.stack ? { stack: sanitize(e.stack, ctx) } : {}),
    ...(e.status ? { status: e.status } : {}),
    ...(e.path ? { path: sanitize(e.path, ctx) } : {}),
    version: sanitize(e.version, ctx),
    platform: sanitize(e.platform, ctx),
  };
}

export type PresentedEntry = ReturnType<typeof present>;

export interface LogsSummary {
  /** Errors in the log. */
  count: number;
  /** Errors in the last 7 days. */
  recentCount: number;
  /** The newest few, newest first, sanitized. */
  recent: PresentedEntry[];
  /** The pre-filled GitHub "new issue" link. */
  issueUrl: string;
  /** How many errors made it into that link (the rest: Copy log). */
  issueIncluded: number;
  /**
   * With ?issue=<id>: whether that error is in the log. If it isn't (its
   * report never arrived), the page keeps its own link for it rather than
   * one about other errors.
   */
  issueFound?: boolean;
  logDir: string;
  /** Windows can open the folder; elsewhere the page shows logDir. */
  canOpenFolder: boolean;
}

/** The whole log as text for "Copy log", newest first. */
export function logAsText(entries: PresentedEntry[], context: IssueContext): string {
  const head = [
    `Granted error log — ${entries.length} error${entries.length === 1 ? "" : "s"}`,
    `Granted ${context.version ?? "unknown"} · ${context.os ?? "unknown"} · provider: ${context.provider ?? "unknown"} · search: ${context.searchMode ?? "unknown"}`,
    "(API keys, email addresses and your user folder were removed.)",
    "",
  ];
  const body = entries.map((e) =>
    [`[${e.time}] ${e.area} ${e.id} (${e.source}${e.status ? `, HTTP ${e.status}` : ""}${e.path ? `, ${e.path}` : ""})`, e.message, e.stack ?? ""]
      .filter(Boolean)
      .join("\n"),
  );
  return [...head, body.join("\n\n")].join("\n");
}

export async function handleLogsGet(req: Req, deps: Partial<LogsDeps> = {}): Promise<Response> {
  const d = { ...REAL_DEPS, ...deps };
  if (!d.isLoopbackRequest(req)) return forbidden();
  const params = new URL(req.url, "http://localhost").searchParams;
  const ctx = d.sanitizeContext();
  const context = d.issueContext();
  const entries = d
    .readEntries()
    .slice()
    .reverse()
    .map((e) => present(e, ctx));

  if (params.get("format") === "text") {
    return new Response(logAsText(entries, context), {
      headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
    });
  }

  const issue = params.get("issue");
  const errorId = isErrorId(issue) ? issue : undefined;
  const link = buildIssueUrl({ errorId, source: "app", context, errors: entries, sanitize: ctx });
  const now = d.now();
  const summary: LogsSummary = {
    count: entries.length,
    recentCount: entries.filter((e) => {
      const t = Date.parse(e.time);
      return !Number.isNaN(t) && now - t <= RECENT_WINDOW_MS;
    }).length,
    recent: entries.slice(0, RECENT_SHOWN),
    issueUrl: link.url,
    issueIncluded: link.included,
    ...(errorId ? { issueFound: link.found } : {}),
    logDir: d.logDir(),
    canOpenFolder: d.platform === "win32" || d.platform === "darwin",
  };
  return NextResponse.json(summary, { headers: { "Cache-Control": "no-store" } });
}

const str = (v: unknown, max: number): string | undefined => (typeof v === "string" && v.trim() ? v.slice(0, max) : undefined);

export async function handleLogsPost(req: Req & { text?: () => Promise<string> }, deps: Partial<LogsDeps> = {}): Promise<Response> {
  const d = { ...REAL_DEPS, ...deps };
  if (!d.isLoopbackRequest(req)) return forbidden();

  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_LOG_BODY_BYTES) {
    return NextResponse.json({ error: "Too large" }, { status: 413 });
  }
  let raw: string;
  try {
    raw = (await req.text?.()) ?? "";
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }
  if (Buffer.byteLength(raw) > MAX_LOG_BODY_BYTES) return NextResponse.json({ error: "Too large" }, { status: 413 });
  let body: { action?: unknown; entry?: unknown };
  try {
    body = JSON.parse(raw) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }
  if (!body || typeof body !== "object") return NextResponse.json({ error: "Invalid request body." }, { status: 400 });

  if (body.action === "clear") {
    return NextResponse.json({ cleared: d.clearLog() });
  }
  if (body.action === "open-folder") {
    const dir = d.logDir();
    const opened = d.platform === "win32" || d.platform === "darwin" ? d.openFolder(dir) : false;
    return NextResponse.json({ opened, path: dir });
  }
  if (body.action !== "log") return NextResponse.json({ error: "Unknown action" }, { status: 400 });

  const entry = body.entry && typeof body.entry === "object" ? (body.entry as Record<string, unknown>) : null;
  const message = str(entry?.["message"], 2000);
  if (!entry || !message) return NextResponse.json({ error: "An error message is required." }, { status: 400 });
  if (!d.allowClientLog()) return NextResponse.json({ error: "Too many error reports — slow down." }, { status: 429 });

  // logError sanitizes everything (message, stack, path) before it touches the disk.
  const id = d.logError(cleanArea(entry["area"]), message, {
    id: isErrorId(entry["id"]) ? entry["id"] : undefined,
    stack: str(entry["stack"], 4000) ?? null,
    path: str(entry["path"], 200),
    source: "client",
  });
  return NextResponse.json({ id }, { status: 201 });
}
