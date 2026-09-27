import { NextResponse } from "next/server";
import { getCorpusInfo } from "@/lib/corpus/store";
import { isRefreshing, readRefreshStatus } from "@/lib/corpus/refreshStatus";

// Reads live filesystem/lock state every call — never cache/prerender this.
export const dynamic = "force-dynamic";

const STALE_MS = 24 * 60 * 60 * 1000;

/** GET /api/corpus — the active corpus's freshness, for the Settings "Refresh
 *  cached grants" panel and the auto-update effect (app/page.tsx). */
export async function GET() {
  const { meta } = getCorpusInfo();
  const builtAt = typeof meta.builtAt === "string" ? meta.builtAt : null;
  const builtAtMs = builtAt ? Date.parse(builtAt) : NaN;
  const stale = Number.isNaN(builtAtMs) || Date.now() - builtAtMs > STALE_MS;
  const status = readRefreshStatus();

  return NextResponse.json({
    builtAt,
    count: meta.count ?? 0,
    stale,
    refreshing: isRefreshing(),
    ...(status.lastError ? { lastError: status.lastError } : {}),
  });
}
