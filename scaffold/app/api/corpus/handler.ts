import { getCorpusInfo, type CorpusInfo } from "@/lib/corpus/store";
import { isRefreshing, readRefreshStatus } from "@/lib/corpus/refreshStatus";

const STALE_MS = 24 * 60 * 60 * 1000;

export type CorpusStatusDeps = {
  getCorpusInfo: () => CorpusInfo;
  isRefreshing: typeof isRefreshing;
  readRefreshStatus: typeof readRefreshStatus;
};

const REAL_DEPS: CorpusStatusDeps = { getCorpusInfo, isRefreshing, readRefreshStatus };

/** Logic behind GET /api/corpus, extracted (like app/api/match/handler.ts) so
 *  route.ts can stay a plain re-export — Next only permits route-handler
 *  exports from route.ts — while tests inject a store/lock/status bound to a
 *  temp baseDir instead of touching the real cwd's data/local/. */
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
    ...(status.lastError ? { lastError: status.lastError, lastAttemptAt: status.lastAttemptAt } : {}),
  };
}
