import { spawn, type ChildProcess } from "node:child_process";
import { NextResponse } from "next/server";
import { isLoopbackRequest } from "@/lib/corpus/loopback";
import { clampCorpusSize } from "@/lib/searchSettings";
import {
  acquireRefreshLock,
  clearStopRequest,
  releaseRefreshLock,
  transferRefreshLock,
  writeRefreshStatus,
} from "@/lib/corpus/refreshStatus";

export type RefreshDeps = {
  isLoopbackRequest: typeof isLoopbackRequest;
  acquireRefreshLock: typeof acquireRefreshLock;
  clearStopRequest: typeof clearStopRequest;
  releaseRefreshLock: typeof releaseRefreshLock;
  transferRefreshLock: typeof transferRefreshLock;
  writeRefreshStatus: typeof writeRefreshStatus;
  spawn: (command: string, args: string[], options: Record<string, unknown>) => ChildProcess;
};

const REAL_DEPS: RefreshDeps = {
  isLoopbackRequest,
  acquireRefreshLock,
  clearStopRequest,
  releaseRefreshLock,
  transferRefreshLock,
  writeRefreshStatus,
  spawn,
};

export async function handleRefreshPost(
  req: { headers: { get(name: string): string | null }; json?: () => Promise<unknown> },
  deps: Partial<RefreshDeps> = {},
) {
  const d = { ...REAL_DEPS, ...deps };

  if (!d.isLoopbackRequest(req)) {
    return NextResponse.json({ error: "Refresh is only available from localhost" }, { status: 403 });
  }

  let max: number | undefined;
  try {
    const n = Number(((await req.json?.()) as { max?: unknown } | undefined)?.max);
    if (Number.isFinite(n)) max = clampCorpusSize(n);
  } catch {
    /* no body: script default */
  }

  if (!d.acquireRefreshLock()) {
    return NextResponse.json({ error: "Refresh already running" }, { status: 409 });
  }
  // A stale stop-request from a prior run must never stop this one. The script itself clears
  // this only when it acquires the lock on its own (a plain `npm run data:refresh`) — tsx boot
  // plus imports takes ~1-3s on Windows, and a Stop click landing in that window would otherwise
  // be written by the browser, then silently erased by the script's own startup.
  d.clearStopRequest();
  const args = ["--import", "tsx", "scripts/refresh-corpus.mjs"];
  if (max != null) args.push("--max", String(max));

  let child: ChildProcess;
  try {
    // Recorded up front so a child that dies before writing its own status still triggers auto-update backoff.
    d.writeRefreshStatus({ lastAttemptAt: new Date().toISOString() });
    child = d.spawn(process.execPath, args, {
      cwd: process.cwd(),
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: { ...process.env, GRANTED_REFRESH_LOCK_HELD: "1" },
    });
  } catch (e) {
    d.releaseRefreshLock();
    throw e;
  }
  child.on("error", (e) => {
    try {
      d.writeRefreshStatus({ lastAttemptAt: new Date().toISOString(), lastError: e.message });
    } finally {
      d.releaseRefreshLock();
    }
  });
  if (typeof child.pid === "number") d.transferRefreshLock(child.pid);
  child.unref?.();

  return NextResponse.json({ started: true }, { status: 202 });
}
