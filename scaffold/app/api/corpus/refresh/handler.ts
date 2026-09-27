import { spawn, type ChildProcess } from "node:child_process";
import { NextResponse } from "next/server";
import { isLoopbackRequest } from "@/lib/corpus/loopback";
import { clampCorpusSize } from "@/lib/searchSettings";
import {
  acquireRefreshLock,
  releaseRefreshLock,
  transferRefreshLock,
  writeRefreshStatus,
} from "@/lib/corpus/refreshStatus";

export type RefreshDeps = {
  isLoopbackRequest: typeof isLoopbackRequest;
  acquireRefreshLock: typeof acquireRefreshLock;
  releaseRefreshLock: typeof releaseRefreshLock;
  transferRefreshLock: typeof transferRefreshLock;
  writeRefreshStatus: typeof writeRefreshStatus;
  spawn: (command: string, args: string[], options: Record<string, unknown>) => ChildProcess;
};

const REAL_DEPS: RefreshDeps = {
  isLoopbackRequest,
  acquireRefreshLock,
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
    /* no/invalid JSON body — use the script's own default */
  }

  // Claim the lock here, synchronously, before spawning — closes the window
  // (measured ~500ms with `node --import tsx`) during which the child hasn't
  // written its own lock yet and a second POST would also get through.
  if (!d.acquireRefreshLock()) {
    return NextResponse.json({ error: "Refresh already running" }, { status: 409 });
  }
  // Record the attempt now, not only on failure — a child that's killed,
  // OOM'd, or fails before it can write its own status would otherwise leave
  // no trace, and auto-update would retry every page load forever. A
  // successful run's wholesale writeRefreshStatus({lastCompletedAt}) clears
  // this.
  d.writeRefreshStatus({ lastAttemptAt: new Date().toISOString() });

  const args = ["--import", "tsx", "scripts/refresh-corpus.mjs"];
  if (max != null) args.push("--max", String(max));

  let child: ChildProcess;
  try {
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
  // A synchronous spawn failure (e.g. ENOENT) surfaces as an 'error' event
  // here, not a thrown exception — without this listener it's an unhandled
  // 'error' on the ChildProcess (crashes the process) and the lock is left
  // held forever, so every subsequent refresh (and every stale auto-update
  // check) 409s against a run that never actually started.
  child.on("error", (e) => {
    d.writeRefreshStatus({ lastAttemptAt: new Date().toISOString(), lastError: e.message });
    d.releaseRefreshLock();
  });
  // Hand the lock to the child's own pid so liveness tracks the long-running
  // refresh, not this short-lived request handler.
  if (typeof child.pid === "number") d.transferRefreshLock(child.pid);
  child.unref?.();

  return NextResponse.json({ started: true }, { status: 202 });
}
