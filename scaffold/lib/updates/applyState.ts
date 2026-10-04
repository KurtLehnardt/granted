/**
 * lib/updates/applyState.ts — in-memory state machine for an in-progress
 * "pull + npm ci" update apply (triggered by POST /api/updates/apply, run by
 * lib/updates/runApply.ts).
 *
 * Deliberately a module-level variable, not a file lock: the subprocesses
 * runApply.ts spawns are plain, non-detached children of this same
 * long-running server process, so there's no multi-process race to guard
 * against — a file lock would be solving a problem this process doesn't have.
 */
export type ApplyPhase = "idle" | "pulling" | "installing" | "done" | "failed";

export interface ApplyState {
  phase: ApplyPhase;
  startedAt?: string;
  completedAt?: string;
  error?: string;
}

let state: ApplyState = { phase: "idle" };

export function readApplyState(): ApplyState {
  return state;
}

/** True (and transitions to "pulling") only when idle/done/failed — false (no-op) while an apply is already running. */
export function tryAcquireApplyLock(): boolean {
  if (state.phase === "pulling" || state.phase === "installing") return false;
  state = { phase: "pulling", startedAt: new Date().toISOString() };
  return true;
}

export function setApplyPhase(phase: "installing"): void {
  state = { ...state, phase };
}

export function markApplyDone(): void {
  state = { phase: "done", completedAt: new Date().toISOString() };
}

export function markApplyFailed(error: string): void {
  state = { phase: "failed", error, completedAt: new Date().toISOString() };
}

/** Test-only reset back to idle. */
export function _resetApplyStateForTests(): void {
  state = { phase: "idle" };
}
