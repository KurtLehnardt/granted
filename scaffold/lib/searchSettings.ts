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
