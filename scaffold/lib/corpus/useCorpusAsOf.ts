"use client";
import { useEffect, useState } from "react";
import { parseBuiltAt, type CorpusAsOf } from "./meta";

let cached: CorpusAsOf | null | undefined;

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
