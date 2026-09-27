import { spawn, type ChildProcess } from "node:child_process";
import { NextResponse } from "next/server";
import { isLoopbackRequest } from "@/lib/corpus/loopback";
import { isRefreshing } from "@/lib/corpus/refreshStatus";

export type RefreshDeps = {
  isLoopbackRequest: typeof isLoopbackRequest;
  isRefreshing: typeof isRefreshing;
  spawn: (command: string, args: string[], options: Record<string, unknown>) => ChildProcess;
};

const REAL_DEPS: RefreshDeps = { isLoopbackRequest, isRefreshing, spawn };

export async function handleRefreshPost(
  req: { headers: { get(name: string): string | null }; ip?: string },
  deps: Partial<RefreshDeps> = {},
) {
  const d = { ...REAL_DEPS, ...deps };

  if (!d.isLoopbackRequest(req)) {
    return NextResponse.json({ error: "Forbidden — loopback only" }, { status: 403 });
  }
  if (d.isRefreshing()) {
    return NextResponse.json({ error: "Refresh already running" }, { status: 409 });
  }

  const child = d.spawn(process.execPath, ["--import", "tsx", "scripts/refresh-corpus.mjs"], {
    cwd: process.cwd(),
    detached: true,
    stdio: "ignore",
    env: process.env,
  });
  child.unref?.();

  return NextResponse.json({ started: true }, { status: 202 });
}
