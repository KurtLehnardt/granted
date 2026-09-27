"use client";
import { useEffect, useState } from "react";
import { parseBuiltAt, type CorpusAsOf } from "./meta";

// Module-scope cache: every OpportunityMap on the page shares one fetch of
// GET /api/corpus instead of each firing its own request.
let cached: CorpusAsOf | null | undefined; // undefined = not fetched yet

/** Client-safe corpus "as of" stamp — fetches GET /api/corpus (server-side
 *  reads the file; see lib/corpus/serverMeta.ts) and formats it the same
 *  way the old build-time static import did. `null` while loading or if the
 *  stamp is missing/unreachable — the caller degrades to a date-free caveat. */
export function useCorpusAsOf(): CorpusAsOf | null {
  const [asOf, setAsOf] = useState<CorpusAsOf | null>(cached ?? null);

  useEffect(() => {
    if (cached !== undefined) return;
    let cancelled = false;
    fetch("/api/corpus")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        const parsed = parseBuiltAt(data);
        cached = parsed;
        if (!cancelled) setAsOf(parsed);
      })
      .catch(() => {
        if (!cancelled) cached = null;
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return asOf;
}
