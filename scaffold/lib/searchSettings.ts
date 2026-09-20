/**
 * Client-only search preferences (localStorage). Today just the "search depth":
 * how many candidates the model scores per search — the main speed lever on a
 * slow local model. Null means "use the server default" (never pin a specific
 * number, so a future default change is picked up automatically).
 *
 * Device-local only, like the auto-fill requirements in lib/mockAuth.ts —
 * nothing here is sent anywhere except as the `maxCandidates` field on the
 * founder's own /api/match request, and "Delete my data" can clear it.
 */
const MAX_CANDIDATES_KEY = "granted:maxCandidates";

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
