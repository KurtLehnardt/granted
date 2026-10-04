import { NextResponse } from "next/server";
import { isLoopbackRequest } from "@/lib/corpus/loopback";
import { buildLocalEmbeddingsStatus, type LocalEmbeddingsStatus } from "@/lib/embeddings/localEmbeddings";
import { startLocalEmbeddingsJob, type StartResult } from "@/lib/embeddings/startLocalEmbeddings";

// GET  /api/llm/embeddings — local search status (Settings polls this while the job runs).
// POST /api/llm/embeddings — start (or retry) the local search setup. Loopback-only: it spawns a process.

export type LocalEmbeddingsRouteDeps = {
  isLoopbackRequest: typeof isLoopbackRequest;
  buildStatus: () => LocalEmbeddingsStatus;
  start: () => StartResult;
};

const REAL_DEPS: LocalEmbeddingsRouteDeps = {
  isLoopbackRequest,
  buildStatus: () => buildLocalEmbeddingsStatus(),
  start: () => startLocalEmbeddingsJob(),
};

export function handleLocalEmbeddingsGet(deps: Partial<LocalEmbeddingsRouteDeps> = {}): Response {
  const d = { ...REAL_DEPS, ...deps };
  return NextResponse.json(d.buildStatus());
}

export function handleLocalEmbeddingsPost(
  req: { headers: { get(name: string): string | null } },
  deps: Partial<LocalEmbeddingsRouteDeps> = {},
): Response {
  const d = { ...REAL_DEPS, ...deps };
  if (!d.isLoopbackRequest(req)) {
    return NextResponse.json({ error: "This setting is only available from localhost." }, { status: 403 });
  }
  const before = d.buildStatus();
  if (before.state === "not-applicable") {
    return NextResponse.json(
      { started: false, reason: "not-applicable", status: before },
      { status: 200 },
    );
  }
  let result: StartResult;
  try {
    result = d.start();
  } catch (e) {
    return NextResponse.json({ error: `Couldn't start local search setup: ${(e as Error).message}` }, { status: 500 });
  }
  if (!result.started) {
    return NextResponse.json({ started: false, reason: result.reason, status: d.buildStatus() }, { status: 409 });
  }
  return NextResponse.json({ started: true, status: d.buildStatus() }, { status: 202 });
}
