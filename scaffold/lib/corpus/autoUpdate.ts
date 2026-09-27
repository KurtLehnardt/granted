export const RETRY_BACKOFF_MS = 12 * 60 * 60 * 1000;

export interface CorpusStatusForAutoUpdate {
  stale: boolean;
  refreshing: boolean;
  lastAttemptAt?: string;
}

/** A successful run clears `lastAttemptAt`, so any recent attempt means one failed or is unfinished. */
export function shouldAutoRefresh(status: CorpusStatusForAutoUpdate, now: number = Date.now()): boolean {
  if (!status.stale || status.refreshing) return false;
  const lastAttemptMs = status.lastAttemptAt ? Date.parse(status.lastAttemptAt) : NaN;
  if (!Number.isNaN(lastAttemptMs) && now - lastAttemptMs < RETRY_BACKOFF_MS) return false;
  return true;
}
