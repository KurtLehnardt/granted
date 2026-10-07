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

/** Off by default: no government API calls unless the user opts in. */
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

const MAX_CORPUS_SIZE_KEY = "granted:maxCorpusSize";
export const MIN_CORPUS_SIZE = 1000;
export const MAX_CORPUS_SIZE = 20000;
export const DEFAULT_CORPUS_SIZE = 1000;

export function clampCorpusSize(n: number): number {
  return Math.min(MAX_CORPUS_SIZE, Math.max(MIN_CORPUS_SIZE, Math.floor(n)));
}

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

/** Per-source "which states should we fetch" selection (Settings' new state-sources
 *  control). Default/fallback — both when nothing is stored yet AND when localStorage
 *  is unavailable — is today's actual unconditional behavior for the three established
 *  sources: California, Illinois, North Carolina on. Utah is meaningfully weaker data
 *  (no deadline/eligibility, no stable id, occasional federal overlap — see
 *  scripts/1-fetch-ut-grants.mjs) and a headless-browser-only source, so it ships
 *  opt-in: off unless the user explicitly turns it on here. */
const STATE_SOURCES_KEY = "granted:selectedStateSources";
export const DEFAULT_STATE_SOURCES = ["ca-grants", "il-grants", "nc-grants"];

export function getSelectedStateSources(): string[] {
  try {
    const raw = window.localStorage.getItem(STATE_SOURCES_KEY);
    if (raw == null) return [...DEFAULT_STATE_SOURCES];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.every((s) => typeof s === "string") ? parsed : [...DEFAULT_STATE_SOURCES];
  } catch {
    return [...DEFAULT_STATE_SOURCES];
  }
}

export function setSelectedStateSources(sources: string[]): void {
  try {
    window.localStorage.setItem(STATE_SOURCES_KEY, JSON.stringify(sources));
  } catch {
    /* localStorage unavailable — nothing to persist */
  }
}
