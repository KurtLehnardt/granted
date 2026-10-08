import { getCorpusInfo, type CorpusInfo } from "@/lib/corpus/store";
import { isRefreshing, isStopRequested, readRefreshStatus } from "@/lib/corpus/refreshStatus";

const STALE_MS = 24 * 60 * 60 * 1000;

export type CorpusStatusDeps = {
  getCorpusInfo: () => CorpusInfo;
  isRefreshing: typeof isRefreshing;
  readRefreshStatus: typeof readRefreshStatus;
  isStopRequested: typeof isStopRequested;
};

const REAL_DEPS: CorpusStatusDeps = { getCorpusInfo, isRefreshing, readRefreshStatus, isStopRequested };

export function buildCorpusStatus(deps: Partial<CorpusStatusDeps> = {}) {
  const d = { ...REAL_DEPS, ...deps };
  const { meta, opportunities } = d.getCorpusInfo();
  const builtAt = typeof meta.builtAt === "string" ? meta.builtAt : null;
  const builtAtMs = builtAt ? Date.parse(builtAt) : NaN;
  const stale = Number.isNaN(builtAtMs) || Date.now() - builtAtMs > STALE_MS;
  const status = d.readRefreshStatus();
  // Distinct source ids actually present in the cached corpus right now --
  // generic (every source, not just state ones), so Settings can tell
  // whether a newly checked state source would need a real fetch, without
  // this handler needing to know what a "state source" is.
  const sourcesPresent = Array.from(new Set(opportunities.map((o) => o.source))).sort();

  return {
    builtAt,
    count: meta.count ?? 0,
    stale,
    sourcesPresent,
    refreshing: d.isRefreshing(),
    ...(status.lastAttemptAt ? { lastAttemptAt: status.lastAttemptAt } : {}),
    ...(status.lastStoppedAt ? { lastStoppedAt: status.lastStoppedAt } : {}),
    ...(status.lastError ? { lastError: status.lastError } : {}),
    ...(status.progress ? { progress: status.progress } : {}),
    ...(status.stopped ? { stopped: status.stopped, savedCount: status.savedCount ?? 0 } : {}),
    // A stop-request file can outlive its run (hard kill); never let it hide the next run's Stop button.
    ...(d.isRefreshing() && d.isStopRequested() ? { stopRequested: true } : {}),
  };
}
