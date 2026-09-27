/**
 * Client-only search preferences (localStorage): "search depth" (how many
 * candidates the model scores per search) and, on a local backend, the chosen
 * model. Null means "use the server default" (never pin a specific value, so a
 * future default change is picked up automatically).
 *
 * Device-local only, like the auto-fill requirements in lib/mockAuth.ts —
 * nothing here is sent anywhere except as fields on the user's own
 * /api/match request.
 */
const MAX_CANDIDATES_KEY = "granted:maxCandidates";
const MODEL_KEY = "granted:model";
export const LAST_SEARCH_MS_KEY = "granted:lastSearchMs";

/** The saved candidate cap, or null when unset (→ server default). */
export function getMaxCandidates(): number | null {
  try {
    const raw = window.localStorage.getItem(MAX_CANDIDATES_KEY);
    if (raw == null || raw === "") return null;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
  } catch {
    // localStorage unavailable (SSR / private mode) — fall back to the default.
    return null;
  }
}

/** Persist the candidate cap; pass null to clear it (→ server default). */
export function setMaxCandidates(value: number | null): void {
  try {
    if (value == null) window.localStorage.removeItem(MAX_CANDIDATES_KEY);
    else window.localStorage.setItem(MAX_CANDIDATES_KEY, String(Math.floor(value)));
  } catch {
    /* localStorage unavailable — nothing to persist */
  }
}

/** The saved local-model choice, or null when unset (→ server default). Ignored when hosted. */
export function getModel(): string | null {
  try {
    return window.localStorage.getItem(MODEL_KEY) || null;
  } catch {
    return null;
  }
}

/** Persist the local model (null → server default). A change drops the last-search
 *  duration, which was measured on the previous model. */
export function setModel(value: string | null): void {
  try {
    if (value === getModel()) return;
    if (value == null) window.localStorage.removeItem(MODEL_KEY);
    else window.localStorage.setItem(MODEL_KEY, value);
    window.localStorage.removeItem(LAST_SEARCH_MS_KEY);
  } catch {
    /* localStorage unavailable — nothing to persist */
  }
}

/**
 * "Auto-update" — when on, the app checks GET /api/corpus once per load and
 * kicks off a background POST /api/corpus/refresh if the local corpus is
 * stale (see components/CorpusAutoUpdate.tsx). Off by default: a local-LLM
 * self-host shouldn't reach out to government APIs without being asked.
 */
const AUTO_UPDATE_KEY = "granted:autoUpdateCorpus";

export function getAutoUpdateCorpus(): boolean {
  try {
    return window.localStorage.getItem(AUTO_UPDATE_KEY) === "1";
  } catch {
    return false;
  }
}

export function setAutoUpdateCorpus(value: boolean): void {
  try {
    if (value) window.localStorage.setItem(AUTO_UPDATE_KEY, "1");
    else window.localStorage.removeItem(AUTO_UPDATE_KEY);
  } catch {
    /* localStorage unavailable — nothing to persist */
  }
}

/**
 * Max cached opportunities (corpus size cap) — see components/CorpusAutoUpdate.tsx
 * / the Settings refresh panel. Applies on the NEXT refresh, not retroactively.
 * Range enforced again server-side (POST /api/corpus/refresh clamps it too).
 */
const MAX_CORPUS_SIZE_KEY = "granted:maxCorpusSize";
export const MIN_CORPUS_SIZE = 1000;
export const MAX_CORPUS_SIZE = 20000;
export const DEFAULT_CORPUS_SIZE = 1000;

export function clampCorpusSize(n: number): number {
  return Math.min(MAX_CORPUS_SIZE, Math.max(MIN_CORPUS_SIZE, Math.floor(n)));
}

/** The saved corpus size cap, clamped to [1000, 20000]. Defaults to 1000. */
export function getMaxCorpusSize(): number {
  try {
    const raw = window.localStorage.getItem(MAX_CORPUS_SIZE_KEY);
    const n = raw == null ? NaN : Number(raw);
    return Number.isFinite(n) ? clampCorpusSize(n) : DEFAULT_CORPUS_SIZE;
  } catch {
    return DEFAULT_CORPUS_SIZE;
  }
}

export function setMaxCorpusSize(value: number): void {
  try {
    window.localStorage.setItem(MAX_CORPUS_SIZE_KEY, String(clampCorpusSize(value)));
  } catch {
    /* localStorage unavailable — nothing to persist */
  }
}
