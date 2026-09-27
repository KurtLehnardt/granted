"use client";

import { useEffect } from "react";
import { getAutoUpdateCorpus, getMaxCorpusSize } from "@/lib/searchSettings";
import { shouldAutoRefresh } from "@/lib/corpus/autoUpdate";

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
        if (!shouldAutoRefresh(status)) return;
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
