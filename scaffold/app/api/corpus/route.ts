import { NextResponse } from "next/server";
import { buildCorpusStatus } from "./handler";

// Reads live filesystem/lock state every call — never cache/prerender this.
export const dynamic = "force-dynamic";

/** GET /api/corpus — the active corpus's freshness, for the Settings "Refresh
 *  cached grants" panel and the auto-update effect (app/page.tsx). Logic
 *  lives in handler.ts for a hermetic test seam (H6) — see its tests. */
export async function GET() {
  return NextResponse.json(buildCorpusStatus());
}
