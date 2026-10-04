import { NextResponse } from "next/server";
import { isLoopbackRequest } from "@/lib/corpus/loopback";
import { getLocalCommit } from "@/lib/updates/git";
import { fetchRemoteCommit } from "@/lib/updates/github";
import { readApplyState } from "@/lib/updates/applyState";

// GET /api/updates — compares the local git checkout against GitHub's main branch. Loopback-only
// (same gate as llm/config and corpus/refresh): unlike the one un-gated GET precedent
// (/api/corpus, a plain file read), this route shells out to git and makes an outbound network
// call on every hit. A failed check is data, not an HTTP error — always 200 except the 403.

export type UpdatesCheckDeps = {
  isLoopbackRequest: typeof isLoopbackRequest;
  getLocalCommit: typeof getLocalCommit;
  fetchRemoteCommit: typeof fetchRemoteCommit;
  readApplyState: typeof readApplyState;
};

const REAL_DEPS: UpdatesCheckDeps = { isLoopbackRequest, getLocalCommit, fetchRemoteCommit, readApplyState };

export async function handleUpdatesGet(
  req: { headers: { get(name: string): string | null } },
  deps: Partial<UpdatesCheckDeps> = {},
) {
  const d = { ...REAL_DEPS, ...deps };

  if (!d.isLoopbackRequest(req)) {
    return NextResponse.json({ error: "Update check is only available from localhost" }, { status: 403 });
  }

  // An apply already in progress or just finished short-circuits the whole check — git/GitHub are
  // never consulted while that authoritative, more-specific answer is available.
  const applyState = d.readApplyState();
  if (applyState.phase === "pulling" || applyState.phase === "installing") {
    return NextResponse.json({ state: "applying", phase: applyState.phase });
  }
  if (applyState.phase === "done") {
    return NextResponse.json({ state: "applied" });
  }
  if (applyState.phase === "failed") {
    return NextResponse.json({ state: "apply-failed", message: applyState.error ?? "Update failed." });
  }

  const local = await d.getLocalCommit();
  if ("notAGitCheckout" in local) {
    // Silent/neutral — a forward-compat hook for any future non-git install method. Not expected
    // to trigger for normal users today.
    return NextResponse.json({ state: "unknown" });
  }

  const remote = await d.fetchRemoteCommit();
  if ("error" in remote) {
    return NextResponse.json({ state: "error", message: remote.error, localSha: local.sha });
  }

  if (local.sha === remote.sha) {
    return NextResponse.json({ state: "up-to-date", sha: local.sha });
  }
  return NextResponse.json({ state: "update-available", localSha: local.sha, remoteSha: remote.sha });
}
