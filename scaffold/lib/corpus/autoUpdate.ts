/** A failed (or crashed/killed) refresh never updates `builtAt`, so GET keeps
 *  reporting `stale: true` — without a backoff, every page load would spawn
 *  another full refresh that's likely to fail the same way (retry storm).
 *  Skip auto-triggering for this long after an attempt; the Settings
 *  "Refresh cached grants" button is unaffected and always allowed. */
export const RETRY_BACKOFF_MS = 12 * 60 * 60 * 1000;

export interface CorpusStatusForAutoUpdate {
  stale: boolean;
  refreshing: boolean;
  lastAttemptAt?: string;
}

/** Pure decision behind CorpusAutoUpdate's effect: whether to POST
 *  /api/corpus/refresh given the last-known status. Keyed on `lastAttemptAt`
 *  alone (not `lastError`) — the attempt is recorded when a refresh starts,
 *  so a child killed/OOM'd before it can write its own error still backs off. */
export function shouldAutoRefresh(status: CorpusStatusForAutoUpdate, now: number = Date.now()): boolean {
  if (!status.stale || status.refreshing) return false;
  const lastAttemptMs = status.lastAttemptAt ? Date.parse(status.lastAttemptAt) : NaN;
  if (!Number.isNaN(lastAttemptMs) && now - lastAttemptMs < RETRY_BACKOFF_MS) return false;
  return true;
}
