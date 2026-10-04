"use client";

import React, { useEffect, useRef, useState } from "react";
import type { LocalEmbeddingsStatus } from "@/lib/embeddings/localEmbeddings";

export type LocalSearchView = {
  tone: "progress" | "ok" | "error" | "info";
  title: string;
  detail?: string;
  pct?: number;
  action?: string;
};

const fmt = (n: number) => n.toLocaleString("en-US");

/**
 * Pure: what Settings → Model → Local says about local search, from GET
 * /api/llm/embeddings. Null when there's nothing to say (embeddings are set in
 * .env.local, or no status yet).
 */
export function describeLocalSearchStatus(s: LocalEmbeddingsStatus | undefined | null): LocalSearchView | null {
  if (!s || s.state === "not-applicable") return null;

  if (s.state === "running") {
    const p = s.progress ?? { stage: "checking" as const };
    const pct = typeof p.pct === "number" ? p.pct : undefined;
    const title =
      p.stage === "pulling"
        ? `Downloading the local search model (${s.model})${pct != null ? `: ${pct}%` : "..."}`
        : p.stage === "embedding"
          ? p.done != null && p.total != null
            ? `Building the local search index: ${fmt(p.done)} of ${fmt(p.total)} grants${pct != null ? ` (${pct}%)` : ""}`
            : "Building the local search index..."
          : p.stage === "saving"
            ? "Saving the local search index..."
            : "Setting up local search: checking Ollama...";
    const detail = s.active
      ? "Search keeps using your current local index until the update finishes."
      : "This runs in the background and can take from a few minutes to half an hour. You can keep using Granted; searches on Local start working as soon as it finishes.";
    return { tone: "progress", title, detail, ...(pct != null ? { pct } : {}) };
  }

  if (s.state === "failed") {
    return {
      tone: "error",
      title: s.error ?? "Setting up local search failed.",
      ...(s.active ? { detail: "Search keeps using your current local index." } : {}),
      action: "Retry",
    };
  }

  if (s.state === "needed") {
    return {
      tone: "info",
      title: "Local search needs a one-time setup.",
      detail: `Granted downloads a small embedding model (${s.model}) through Ollama and indexes the grants on this machine, in the background. Until it's done, searches can't run on Local.`,
      action: "Set up local search",
    };
  }

  // ready
  if (s.outdated) {
    return {
      tone: "info",
      title: "Local search is ready, but the grant list changed since it was indexed.",
      detail: "Search uses the existing index until you update it; only new or changed grants are re-indexed.",
      action: "Update local search",
    };
  }
  return {
    tone: "ok",
    title: `Search runs on this machine (${s.model}${s.count ? `, ${fmt(s.count)} grants indexed` : ""}).`,
  };
}

/**
 * Status + action for Settings → Local's background local-search setup. Polls
 * GET /api/llm/embeddings while the job runs; the action button POSTs to start
 * (or retry) it. `onReady` lets the parent refresh once search switches over.
 */
export default function LocalSearchStatus({
  initialStatus,
  onReady,
  autoStart = false,
  pollMs = 2000,
}: {
  initialStatus?: LocalEmbeddingsStatus | null;
  onReady?: () => void;
  /** Start a never-attempted setup on sight (Local was already selected before this existed). A failure still waits for Retry. */
  autoStart?: boolean;
  pollMs?: number;
}) {
  const [status, setStatus] = useState<LocalEmbeddingsStatus | null>(initialStatus ?? null);
  const [busy, setBusy] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const prevState = useRef(status?.state);
  const autoStarted = useRef(false);

  // The parent re-fetches GET /api/llm after a provider switch; adopt its newer status.
  useEffect(() => {
    if (initialStatus) setStatus(initialStatus);
  }, [initialStatus]);

  useEffect(() => {
    if (status?.state !== "running") return;
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
  }, [status?.state, pollMs]);

  useEffect(() => {
    if (prevState.current === "running" && status?.state === "ready") onReady?.();
    prevState.current = status?.state;
  }, [status?.state, onReady]);

  useEffect(() => {
    if (!autoStart || autoStarted.current || status?.state !== "needed") return;
    autoStarted.current = true;
    void start();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoStart, status?.state]);

  async function start() {
    setBusy(true);
    setStartError(null);
    try {
      const res = await fetch("/api/llm/embeddings", { method: "POST" });
      const json = await res.json().catch(() => ({}));
      if (json?.status) setStatus(json.status);
      if (!res.ok && res.status !== 409) setStartError(json?.error ?? `Couldn't start local search setup (HTTP ${res.status}).`);
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
      className={`mt-2 rounded-r-sm border-l-2 ${border} bg-canvas-alt px-3 py-2 font-body text-[12px] text-foreground`}
      data-testid="local-search-status"
      data-state={status?.state}
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
          aria-label="Local search setup progress"
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
