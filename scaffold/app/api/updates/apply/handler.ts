import { NextResponse } from "next/server";
import { isLoopbackRequest } from "@/lib/corpus/loopback";
import { tryAcquireApplyLock } from "@/lib/updates/applyState";
import { runApplyInBackground } from "@/lib/updates/runApply";

// POST /api/updates/apply — kicks off `git pull --ff-only` + `npm ci` in the background and
// returns immediately. Loopback-only, single-flight (matches corpus/refresh's 409-for-
// already-running convention). The actual apply is fire-and-forget: `runApplyInBackground` is
// never awaited here, so this handler's own promise settles well before the pull/install finish.
// Progress lives in lib/updates/applyState.ts; GET /api/updates polls it.

export type UpdatesApplyDeps = {
  isLoopbackRequest: typeof isLoopbackRequest;
  tryAcquireApplyLock: typeof tryAcquireApplyLock;
  runApplyInBackground: typeof runApplyInBackground;
};

const REAL_DEPS: UpdatesApplyDeps = { isLoopbackRequest, tryAcquireApplyLock, runApplyInBackground };

export async function handleUpdatesApplyPost(
  req: { headers: { get(name: string): string | null } },
  deps: Partial<UpdatesApplyDeps> = {},
) {
  const d = { ...REAL_DEPS, ...deps };

  if (!d.isLoopbackRequest(req)) {
    return NextResponse.json({ error: "Update check is only available from localhost" }, { status: 403 });
  }

  if (!d.tryAcquireApplyLock()) {
    return NextResponse.json({ error: "Update already in progress" }, { status: 409 });
  }

  void d.runApplyInBackground();
  return NextResponse.json({ started: true }, { status: 202 });
}
