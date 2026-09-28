import { NextResponse } from "next/server";
import { isLoopbackRequest } from "@/lib/corpus/loopback";
import { isRefreshing, requestStop } from "@/lib/corpus/refreshStatus";

export type StopDeps = {
  isLoopbackRequest: typeof isLoopbackRequest;
  isRefreshing: typeof isRefreshing;
  requestStop: typeof requestStop;
};

const REAL_DEPS: StopDeps = { isLoopbackRequest, isRefreshing, requestStop };

export async function handleRefreshStopPost(
  req: { headers: { get(name: string): string | null } },
  deps: Partial<StopDeps> = {},
) {
  const d = { ...REAL_DEPS, ...deps };

  if (!d.isLoopbackRequest(req)) {
    return NextResponse.json({ error: "Refresh is only available from localhost" }, { status: 403 });
  }
  if (!d.isRefreshing()) {
    return NextResponse.json({ error: "No refresh is running" }, { status: 404 });
  }
  d.requestStop();
  return NextResponse.json({ stopping: true });
}
