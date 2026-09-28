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
  const { meta } = d.getCorpusInfo();
  const builtAt = typeof meta.builtAt === "string" ? meta.builtAt : null;
  const builtAtMs = builtAt ? Date.parse(builtAt) : NaN;
  const stale = Number.isNaN(builtAtMs) || Date.now() - builtAtMs > STALE_MS;
  const status = d.readRefreshStatus();

  return {
    builtAt,
    count: meta.count ?? 0,
    stale,
    refreshing: d.isRefreshing(),
    ...(status.lastAttemptAt ? { lastAttemptAt: status.lastAttemptAt } : {}),
    ...(status.lastStoppedAt ? { lastStoppedAt: status.lastStoppedAt } : {}),
    ...(status.lastError ? { lastError: status.lastError } : {}),
    ...(status.progress ? { progress: status.progress } : {}),
    ...(status.stopped ? { stopped: status.stopped, savedCount: status.savedCount ?? 0 } : {}),
    // Survives a modal close/reopen: a stop was requested but the child hasn't finished handling it yet.
    ...(d.isStopRequested() ? { stopRequested: true } : {}),
  };
}
