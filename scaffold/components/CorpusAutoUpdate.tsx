"use client";

import { useEffect } from "react";
import { getAutoUpdateCorpus, getMaxCorpusSize } from "@/lib/searchSettings";

/** A failed refresh never updates `builtAt`, so GET keeps reporting
 *  `stale: true` — without a backoff, every page load would spawn another
 *  full refresh that's likely to fail the same way (retry storm). Skip
 *  auto-triggering for this long after a failed attempt; the Settings
 *  "Refresh cached grants" button is unaffected and always allowed. */
const RETRY_BACKOFF_MS = 12 * 60 * 60 * 1000;

/**
 * Always-on, no-UI effect (mounted once in app/layout.tsx, alongside the
 * other passive providers). When "Auto-update" is on (Settings), checks
 * GET /api/corpus once per load and kicks off a background refresh if the
 * local corpus is stale and nothing is already running. Never fires when
 * offline or when auto-update is off — this app is local-LLM-first and
 * shouldn't reach out to government APIs uninvited.
 */
export default function CorpusAutoUpdate() {
  useEffect(() => {
    if (!getAutoUpdateCorpus()) return;
    if (typeof navigator !== "undefined" && !navigator.onLine) return;

    (async () => {
      try {
        const res = await fetch("/api/corpus");
        if (!res.ok) return;
        const status = await res.json();
        if (!status.stale || status.refreshing) return;
        const lastAttemptMs = status.lastError ? Date.parse(status.lastAttemptAt) : NaN;
        if (!Number.isNaN(lastAttemptMs) && Date.now() - lastAttemptMs < RETRY_BACKOFF_MS) return;
        await fetch("/api/corpus/refresh", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ max: getMaxCorpusSize() }),
        });
      } catch {
        /* offline / unreachable — silently skip, this is best-effort */
      }
    })();
  }, []);

  return null;
}
