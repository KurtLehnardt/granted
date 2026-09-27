import { spawn, type ChildProcess } from "node:child_process";
import { NextResponse } from "next/server";
import { isLoopbackRequest } from "@/lib/corpus/loopback";
import { acquireRefreshLock, releaseRefreshLock, transferRefreshLock } from "@/lib/corpus/refreshStatus";

export type RefreshDeps = {
  isLoopbackRequest: typeof isLoopbackRequest;
  acquireRefreshLock: typeof acquireRefreshLock;
  releaseRefreshLock: typeof releaseRefreshLock;
  transferRefreshLock: typeof transferRefreshLock;
  spawn: (command: string, args: string[], options: Record<string, unknown>) => ChildProcess;
};

const REAL_DEPS: RefreshDeps = {
  isLoopbackRequest,
  acquireRefreshLock,
  releaseRefreshLock,
  transferRefreshLock,
  spawn,
};

export async function handleRefreshPost(
  req: { headers: { get(name: string): string | null }; ip?: string },
  deps: Partial<RefreshDeps> = {},
) {
  const d = { ...REAL_DEPS, ...deps };

  if (!d.isLoopbackRequest(req)) {
    return NextResponse.json({ error: "Forbidden — loopback only" }, { status: 403 });
  }
  // Claim the lock here, synchronously, before spawning — closes the window
  // (measured ~500ms with `node --import tsx`) during which the child hasn't
  // written its own lock yet and a second POST would also get through.
  if (!d.acquireRefreshLock()) {
    return NextResponse.json({ error: "Refresh already running" }, { status: 409 });
  }

  let child: ChildProcess;
  try {
    child = d.spawn(process.execPath, ["--import", "tsx", "scripts/refresh-corpus.mjs"], {
      cwd: process.cwd(),
      detached: true,
      stdio: "ignore",
      env: { ...process.env, GRANTED_REFRESH_LOCK_HELD: "1" },
    });
  } catch (e) {
    d.releaseRefreshLock();
    throw e;
  }
  // Hand the lock to the child's own pid so liveness tracks the long-running
  // refresh, not this short-lived request handler.
  if (typeof child.pid === "number") d.transferRefreshLock(child.pid);
  child.unref?.();

  return NextResponse.json({ started: true }, { status: 202 });
}
