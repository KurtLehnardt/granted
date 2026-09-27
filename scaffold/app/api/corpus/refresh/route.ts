import type { NextRequest } from "next/server";
import { handleRefreshPost } from "./handler";

/**
 * POST /api/corpus/refresh — spawns `npm run data:refresh` as a detached
 * child. Loopback-only: this triggers real network fetches against public
 * government APIs, so it must never be reachable from anyone but the person
 * running this install. Logic lives in handler.ts for a hermetic test seam
 * (H6, same shape as app/api/match/handler.ts) — tests inject a fake spawn.
 */
export async function POST(req: NextRequest) {
  return handleRefreshPost(req);
}
