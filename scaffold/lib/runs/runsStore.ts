/**
 * runsStore.ts — persist completed opportunity-map runs client-side (R9.2 /
 * arch review MEDIUM).
 *
 * A completed search is a ~2-minute, real-money result that previously lived
 * only in `app/page.tsx` React state, so a reload or accidental navigation lost
 * it irrecoverably. The `ff.runs.v1` storage key and the `run_revisited` event
 * were built for exactly this but never wired. This module writes the last N
 * completed maps and restores the most recent on reload.
 *
 * Client-only + localStorage-backed (the user's own browser — NOT server-side
 * retention, so §5.3 is unaffected; `clearAllLocalData()` already wipes this
 * key). Framework-agnostic and never-throw, matching lib/mockAuth / lib/localStore.
 */

import { STORAGE_KEYS } from "@/lib/mockAuth";
import { readJSON, writeJSON } from "@/lib/localStore";
import type { OpportunityMap } from "@/lib/types";
import { dropPastAwardMatches } from "@/lib/corpus/pastAwards";

/** How many recent runs to keep. Small — this is "don't lose the last result",
 *  not a full history feature. */
export const MAX_SAVED_RUNS = 5;

export type SavedRun = {
  id: string;
  savedAt: string;
  map: OpportunityMap;
};

function isSavedRun(v: unknown): v is SavedRun {
  return (
    !!v &&
    typeof v === "object" &&
    typeof (v as SavedRun).id === "string" &&
    typeof (v as SavedRun).savedAt === "string" &&
    !!(v as SavedRun).map &&
    typeof (v as SavedRun).map === "object"
  );
}

/** All saved runs, most-recent first, with past-award matches stripped. Tolerant of malformed stored data. */
export function loadRuns(): SavedRun[] {
  const raw = readJSON<unknown>(STORAGE_KEYS.runs, []);
  if (!Array.isArray(raw)) return [];
  return raw.filter(isSavedRun).map((run) =>
    Array.isArray(run.map?.matches) ? { ...run, map: dropPastAwardMatches(run.map) } : run,
  );
}

/** The most recent saved run, or null. */
export function latestRun(): SavedRun | null {
  return loadRuns()[0] ?? null;
}

/**
 * Prepend `map` as the newest run, cap the list at MAX_SAVED_RUNS, and persist.
 * Returns the updated list. Never throws.
 */
export function saveRun(map: OpportunityMap): SavedRun[] {
  const run: SavedRun = {
    id: `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    savedAt: new Date().toISOString(),
    map,
  };
  const next = [run, ...loadRuns()].slice(0, MAX_SAVED_RUNS);
  writeJSON(STORAGE_KEYS.runs, next);
  return next;
}
