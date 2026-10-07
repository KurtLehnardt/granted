import { NextResponse } from "next/server";
import { isLoopbackRequest } from "@/lib/corpus/loopback";
import { buildSearchStatus, type SearchStatus } from "@/lib/embeddings/searchStatus";
import { startBuiltinModelDownload } from "@/lib/embeddings/builtin";

// GET  /api/llm/embeddings — the "Search" line's status: which embeddings search uses,
//                            and the built-in model's download state (Settings polls it).
// POST /api/llm/embeddings — download the built-in search model now (it otherwise downloads
//                            on the first search). Loopback-only: it writes to disk.

export type SearchStatusRouteDeps = {
  isLoopbackRequest: typeof isLoopbackRequest;
  buildStatus: () => SearchStatus;
  startDownload: () => void;
};

const REAL_DEPS: SearchStatusRouteDeps = {
  isLoopbackRequest,
  buildStatus: () => buildSearchStatus(),
  startDownload: () => startBuiltinModelDownload(),
};

export function handleSearchStatusGet(deps: Partial<SearchStatusRouteDeps> = {}): Response {
  const d = { ...REAL_DEPS, ...deps };
  return NextResponse.json(d.buildStatus());
}

export function handleSearchModelDownloadPost(
  req: { headers: { get(name: string): string | null } },
  deps: Partial<SearchStatusRouteDeps> = {},
): Response {
  const d = { ...REAL_DEPS, ...deps };
  if (!d.isLoopbackRequest(req)) {
    return NextResponse.json({ error: "This setting is only available from localhost." }, { status: 403 });
  }
  const before = d.buildStatus();
  if (before.builtin.state === "ready" || before.builtin.state === "downloading") {
    return NextResponse.json({ started: false, status: before }, { status: 200 });
  }
  try {
    d.startDownload();
  } catch (e) {
    return NextResponse.json({ error: `Couldn't start the download: ${(e as Error).message}` }, { status: 500 });
  }
  return NextResponse.json({ started: true, status: d.buildStatus() }, { status: 202 });
}
