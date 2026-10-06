"use client";

import React, { useCallback, useEffect, useState } from "react";
import type { LogsSummary } from "@/app/api/logs/handler";
import { ERROR_LOGGED_EVENT } from "@/lib/errorLog/client";

/**
 * Settings → Problems & logs: how many errors Granted has hit lately, the last
 * few (already sanitized by the server), and
 *   - Report a problem: a pre-filled GitHub issue in the user's browser,
 *     which they review and submit with their own account (nothing is sent
 *     until they do; Granted holds no GitHub token);
 *   - Copy log: the whole sanitized log, for pasting into that issue;
 *   - Open log folder: Explorer on Windows, the folder's path elsewhere;
 *   - Clear log.
 *
 * `initialSummary` is the hermetic test seam (no network), as in AppUpdateSection.
 */
type Note = { ok: boolean; text: string } | null;

export default function ProblemsSection({ initialSummary }: { initialSummary?: LogsSummary }) {
  const [summary, setSummary] = useState<LogsSummary | null>(initialSummary ?? null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [note, setNote] = useState<Note>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/logs");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setSummary((await res.json()) as LogsSummary);
      setLoadFailed(false);
    } catch {
      setLoadFailed(true);
    }
  }, []);

  useEffect(() => {
    if (initialSummary) return;
    void load();
    // Errors that happen while Settings is open: the count, the list and the
    // report link follow (the link must never be one built before they arrived).
    const onLogged = () => void load();
    window.addEventListener(ERROR_LOGGED_EVENT, onLogged);
    return () => window.removeEventListener(ERROR_LOGGED_EVENT, onLogged);
  }, [initialSummary, load]);

  // Just before a click (pointer over it, or keyboard focus on it): the freshest link,
  // including server-side errors logged since Settings opened.
  const refreshSoon = useCallback(() => {
    if (!initialSummary) void load();
  }, [initialSummary, load]);

  async function handleCopy() {
    setBusy(true);
    try {
      const res = await fetch("/api/logs?format=text");
      if (!res.ok) throw new Error();
      await navigator.clipboard.writeText(await res.text());
      setNote({ ok: true, text: "The log is on your clipboard (keys, emails and your user folder removed)." });
    } catch {
      setNote({ ok: false, text: "Couldn't copy the log." });
    } finally {
      setBusy(false);
    }
  }

  async function post(action: "clear" | "open-folder") {
    const res = await fetch("/api/logs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action }),
    });
    if (!res.ok) throw new Error();
    return (await res.json()) as { cleared?: boolean; opened?: boolean; path?: string };
  }

  async function handleOpenFolder() {
    try {
      const r = await post("open-folder");
      setNote(r.opened ? { ok: true, text: `Opened ${r.path}` } : { ok: true, text: `The log is in ${r.path ?? summary?.logDir}` });
    } catch {
      setNote({ ok: false, text: summary ? `The log is in ${summary.logDir}` : "Couldn't open the log folder." });
    }
  }

  async function handleClear() {
    if (!confirmClear()) return;
    setBusy(true);
    try {
      const r = await post("clear");
      setNote(r.cleared ? { ok: true, text: "Log cleared." } : { ok: false, text: "Couldn't clear all of the log." });
      await load();
    } catch {
      setNote({ ok: false, text: "Couldn't clear the log." });
    } finally {
      setBusy(false);
    }
  }

  const legendClass = "font-mono text-[11px] uppercase tracking-eyebrow text-foreground";
  const textClass = "mt-1.5 font-body text-[12px] text-foreground opacity-80";
  const btnClass =
    "inline-flex min-h-[44px] items-center rounded-sm border border-structure-on-canvas px-4 py-2 font-mono text-[11px] uppercase tracking-eyebrow text-structure-on-canvas transition hover:bg-structure hover:text-token-white active:scale-[0.98] disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-structure-on-canvas focus-visible:ring-offset-2";

  return (
    <div className="mt-5 border-t border-structure-on-canvas pt-4" data-testid="problems-logs">
      <span className={legendClass}>Problems &amp; logs</span>
      <p className={textClass} data-testid="problems-count">
        {countText(summary, loadFailed)}
      </p>

      {summary && summary.recent.length > 0 && (
        <ul className="mt-2 space-y-1.5" aria-label="Recent errors">
          {summary.recent.map((e) => (
            <li key={`${e.id}-${e.time}`} className="font-body text-[12px] text-foreground">
              <span className="font-mono text-[11px] opacity-70">
                {shortTime(e.time)} · {e.area} · {e.id}
              </span>
              <span className="block break-words">{e.message}</span>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <a
          href={summary?.issueUrl ?? "https://github.com/KurtLehnardt/granted/issues/new?labels=bug"}
          target="_blank"
          rel="noopener noreferrer"
          className={btnClass}
          data-testid="report-problem"
          onPointerEnter={refreshSoon}
          onFocus={refreshSoon}
        >
          Report a problem
        </a>
        <button type="button" onClick={handleCopy} disabled={busy || !summary || summary.count === 0} className={btnClass}>
          Copy log
        </button>
        <button type="button" onClick={handleOpenFolder} disabled={busy} className={btnClass}>
          Open log folder
        </button>
        <button type="button" onClick={handleClear} disabled={busy || !summary || summary.count === 0} className={btnClass}>
          Clear log
        </button>
      </div>

      <p className={textClass}>
        Report a problem opens a GitHub issue in your browser, filled in with the recent errors. API keys, email
        addresses and your user folder are removed first, and nothing is sent until you review it and press Submit.
        {summary && !summary.canOpenFolder ? ` The log is in ${summary.logDir}.` : ""}
      </p>
      {note && (
        <p className={textClass} role={note.ok ? "status" : "alert"} data-testid="problems-note">
          {note.text}
        </p>
      )}
    </div>
  );
}

/** Clearing can't be undone: ask first. */
export function confirmClear(ask: (message: string) => boolean = (m) => (typeof window === "undefined" ? false : window.confirm(m))): boolean {
  try {
    return ask("Clear Granted's error log? The errors in it can't be reported afterwards.");
  } catch {
    return false;
  }
}

export function countText(summary: LogsSummary | null, loadFailed = false): string {
  if (!summary) return loadFailed ? "Couldn't read the error log." : "Reading the error log…";
  if (summary.count === 0) return "No errors recorded.";
  const recent = `${summary.recentCount} error${summary.recentCount === 1 ? "" : "s"} in the last 7 days`;
  return summary.count === summary.recentCount ? `${recent}.` : `${recent} (${summary.count} in the log).`;
}

function shortTime(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  return new Date(t).toISOString().replace("T", " ").slice(0, 16);
}
