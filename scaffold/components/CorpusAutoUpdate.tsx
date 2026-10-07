"use client";

import { useEffect } from "react";
import { getAutoUpdateCorpus, getMaxCorpusSize, getSelectedStateSources } from "@/lib/searchSettings";
import { shouldAutoRefresh } from "@/lib/corpus/autoUpdate";

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
          body: JSON.stringify({ max: getMaxCorpusSize(), stateSources: getSelectedStateSources() }),
        });
      } catch {
        /* best-effort */
      }
    })();
  }, []);

  return null;
}
