import { spawn, type ChildProcess } from "node:child_process";
import { NextResponse } from "next/server";
import { isLoopbackRequest } from "@/lib/corpus/loopback";
import { clampCorpusSize } from "@/lib/searchSettings";
import { logError } from "@/lib/errorLog/server";
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

// Settings' per-state "refresh just this one" link. Kept in sync by hand with
// refresh-corpus.mjs's own TOGGLEABLE_STATE_SOURCES (not imported -- that
// file runs a real refresh unconditionally on import, so nothing imports it).
const TOGGLEABLE_STATE_SOURCES = ["ca-grants", "il-grants", "nc-grants", "ut-grants"];

export async function handleRefreshPost(
  req: { headers: { get(name: string): string | null }; json?: () => Promise<unknown> },
  deps: Partial<RefreshDeps> = {},
) {
  const d = { ...REAL_DEPS, ...deps };

  if (!d.isLoopbackRequest(req)) {
    return NextResponse.json({ error: "Refresh is only available from localhost" }, { status: 403 });
  }

  let max: number | undefined;
  let stateSources: string[] | undefined;
  let onlySource: string | undefined;
  try {
    const body = (await req.json?.()) as { max?: unknown; stateSources?: unknown; onlySource?: unknown } | undefined;
    const n = Number(body?.max);
    if (Number.isFinite(n)) max = clampCorpusSize(n);
    if (Array.isArray(body?.stateSources) && body.stateSources.every((s) => typeof s === "string")) {
      stateSources = body.stateSources;
    }
    if (typeof body?.onlySource === "string" && TOGGLEABLE_STATE_SOURCES.includes(body.onlySource)) {
      onlySource = body.onlySource;
    }
  } catch {
    /* no body: script default */
  }

  if (!d.acquireRefreshLock()) {
    return NextResponse.json({ error: "Refresh already running" }, { status: 409 });
  }
  // Clear here, not in the script, so a Stop clicked during tsx boot isn't erased by its own startup.
  d.clearStopRequest();
  const args = ["--import", "tsx", "scripts/refresh-corpus.mjs"];
  if (max != null) args.push("--max", String(max));
  if (stateSources != null) args.push(`--state-sources=${stateSources.join(",")}`);
  if (onlySource != null) args.push(`--only-source=${onlySource}`);

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
    logError("corpus-refresh", e);
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
