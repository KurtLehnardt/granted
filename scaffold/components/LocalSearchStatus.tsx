"use client";

import React, { useEffect, useState } from "react";
import type { SearchStatus } from "@/lib/embeddings/searchStatus";

export type LocalSearchView = {
  tone: "progress" | "ok" | "error" | "info";
  title: string;
  detail?: string;
  pct?: number;
  action?: string;
};

const mb = (bytes: number) => `${Math.round(bytes / 1e6)} MB`;
const fmt = (n: number) => n.toLocaleString("en-US");

/**
 * Pure: the "Search" line in Settings → Model, from GET /api/llm/embeddings.
 * Says which embeddings search uses and, for the built-in model, whether its
 * files are downloaded. Null when there's no status yet.
 */
export function describeLocalSearchStatus(s: SearchStatus | undefined | null): LocalSearchView | null {
  if (!s) return null;
  const view = describeSpace(s);
  const extra = [coverageText(s), s.note].filter(Boolean).join(" ");
  return extra ? { ...view, detail: view.detail ? `${view.detail} ${extra}` : extra } : view;
}

/** "4,120 of 4,698 grants are indexed for search; indexing the rest in the background (40%)." Empty when everything is indexed. */
function coverageText(s: SearchStatus): string {
  const c = s.coverage;
  if (!c || c.withVectors >= c.total) return "";
  const base = `${fmt(c.withVectors)} of ${fmt(c.total)} grants are indexed for search; the rest are found by keyword`;
  if (c.backfill?.running) {
    const pct = c.backfill.total ? Math.floor(((c.backfill.done ?? 0) / c.backfill.total) * 100) : 0;
    return `${base} until they're indexed, which is running in the background (${pct}%).`;
  }
  if (c.backfill?.error) return `${base}: ${c.backfill.error}.`;
  return `${base} until they're indexed in the background.`;
}

function describeSpace(s: SearchStatus): LocalSearchView {
  if (s.space === "openai") {
    return {
      tone: "info",
      title: "Search: OpenAI embeddings",
      detail: "Uses your OpenAI key. To search on this computer instead, set SEARCH_EMBEDDINGS=builtin in .env.local.",
    };
  }
  if (s.space === "custom") {
    return { tone: "info", title: `Search: your embedding server (${s.model})`, detail: `Set in .env.local (${s.reason}).` };
  }

  const title = "Search: Built-in, on this computer";
  const b = s.builtin;
  if (b.state === "downloading") {
    const pct = typeof b.pct === "number" ? b.pct : 0;
    return {
      tone: "progress",
      title: `${title}. Downloading the search model: ${pct}%`,
      detail: `A one-time download of about ${mb(b.totalBytes)}. Searches start as soon as it finishes.`,
      pct,
    };
  }
  if (b.state === "failed") {
    const reason = b.error ? `${b.error[0].toUpperCase()}${b.error.slice(1)}.` : "Downloading the search model failed.";
    return { tone: "error", title: reason, detail: "Until this is fixed, search runs in keyword-only mode.", action: "Retry" };
  }
  if (b.state === "missing") {
    return {
      tone: "info",
      title,
      detail: `The search model (about ${mb(b.totalBytes)}) isn't downloaded yet. It downloads by itself on your first search, or now.`,
      action: "Download now",
    };
  }
  return { tone: "ok", title, detail: `${b.model}. No key needed, and it works offline.` };
}

/**
 * The "Search" line in Settings → Model. Polls GET /api/llm/embeddings while the
 * built-in model downloads; the action button POSTs to start (or retry) the download.
 */
export default function LocalSearchStatus({
  initialStatus,
  pollMs = 2000,
}: {
  initialStatus?: SearchStatus | null;
  pollMs?: number;
}) {
  const [status, setStatus] = useState<SearchStatus | null>(initialStatus ?? null);
  const [busy, setBusy] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);

  // The parent re-fetches GET /api/llm after a provider switch; adopt its newer status.
  useEffect(() => {
    if (initialStatus) setStatus(initialStatus);
  }, [initialStatus]);

  const downloading = status?.builtin.state === "downloading" || Boolean(status?.coverage?.backfill?.running);
  useEffect(() => {
    if (!downloading) return;
    let cancelled = false;
    const timer = setInterval(async () => {
      try {
        const res = await fetch("/api/llm/embeddings");
        if (!res.ok || cancelled) return;
        setStatus(await res.json());
      } catch {
        /* server restarting: keep the last status and try again */
      }
    }, pollMs);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [downloading, pollMs]);

  async function start() {
    setBusy(true);
    setStartError(null);
    try {
      const res = await fetch("/api/llm/embeddings", { method: "POST" });
      const json = await res.json().catch(() => ({}));
      if (json?.status) setStatus(json.status);
      if (!res.ok) setStartError(json?.error ?? `Couldn't start the download (HTTP ${res.status}).`);
    } catch {
      setStartError("Couldn't reach the server. Try again.");
    } finally {
      setBusy(false);
    }
  }

  const view = describeLocalSearchStatus(status);
  if (!view) return null;
  const border = view.tone === "error" ? "border-error" : "border-structure-on-canvas";

  return (
    <div
      className={`mt-3 rounded-r-sm border-l-2 ${border} bg-canvas-alt px-3 py-2 font-body text-[12px] text-foreground`}
      data-testid="search-status"
      data-space={status?.space}
      data-state={status?.builtin.state}
      role="status"
      aria-live="polite"
    >
      <p>{view.title}</p>
      {view.pct != null && (
        <div
          className="mt-1.5 h-1.5 w-full overflow-hidden rounded-sm border border-structure-on-canvas"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={view.pct}
          aria-label="Search model download progress"
        >
          <div className="h-full bg-structure" style={{ width: `${view.pct}%` }} />
        </div>
      )}
      {view.detail && <p className="mt-1 opacity-80">{view.detail}</p>}
      {view.action && (
        <button
          type="button"
          onClick={start}
          disabled={busy}
          className="mt-2 inline-flex min-h-[32px] items-center rounded-sm border border-structure-on-canvas px-3 py-1 font-mono text-[11px] uppercase tracking-eyebrow text-structure-on-canvas transition hover:bg-structure hover:text-token-white disabled:opacity-50"
        >
          {busy ? "Starting..." : view.action}
        </button>
      )}
      {startError && <p className="mt-1">{startError}</p>}
    </div>
  );
}
