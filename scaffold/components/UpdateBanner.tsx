"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { isFlagEnabled } from "@/lib/flags";

/**
 * UpdateBanner.tsx — full-width "check for updates" bar mounted at the very
 * top of <body> (see app/layout.tsx), beside the always-on, self-gating
 * CorpusAutoUpdate. Same posture: it checks the `update_check` flag itself
 * and renders nothing until there's something worth telling the user about
 * (see shouldShowBanner below) — unknown/up-to-date/error all stay silent.
 *
 * Polls GET /api/updates (loopback-gated server-side, independent of this
 * flag) once on mount, then every 3s while an apply is in progress —
 * mirroring SettingsForm.tsx's poll-while-refreshing `setInterval`/`pollRef`
 * pattern. SettingsForm's own "App updates" section fetches independently
 * of this component; both reflect the same server-side applyState, so that
 * duplication is intentional, not a bug (same posture as CorpusAutoUpdate
 * and SettingsForm both independently polling /api/corpus today).
 */

export type CheckResponse =
  | { state: "unknown" }
  | { state: "up-to-date"; sha: string }
  | { state: "update-available"; localSha: string; remoteSha: string }
  | { state: "applying"; phase: "pulling" | "installing" }
  | { state: "applied" }
  | { state: "apply-failed"; message: string }
  | { state: "error"; message: string; localSha?: string };

const DISMISSED_SHA_KEY = "granted.update.dismissedSha";

/** The last SHA the user dismissed an "update available" banner for, or null. Never throws. */
function getDismissedSha(): string | null {
  try {
    return window.localStorage.getItem(DISMISSED_SHA_KEY);
  } catch {
    return null;
  }
}

/** Persist the dismissed SHA so the banner doesn't re-show for it — but does reappear once a
 *  newer SHA is found. Never throws. */
function setDismissedSha(sha: string): void {
  try {
    window.localStorage.setItem(DISMISSED_SHA_KEY, sha);
  } catch {
    /* localStorage unavailable — nothing to persist */
  }
}

/**
 * True only for the states worth surfacing — stays silent for `unknown` (no git checkout, a
 * forward-compat hook), `up-to-date` (nothing to say), and `error` (a failed check is quiet, not
 * alarming). Exported and kept pure so it's unit-testable across all 7 states without rendering.
 */
export function shouldShowBanner(
  res: CheckResponse | null,
): res is Extract<CheckResponse, { state: "update-available" | "applying" | "applied" | "apply-failed" }> {
  return (
    res?.state === "update-available" ||
    res?.state === "applying" ||
    res?.state === "applied" ||
    res?.state === "apply-failed"
  );
}

const BAR_CLASS =
  "w-full border-b-2 border-info bg-canvas-alt px-4 py-2.5 text-center font-body text-sm text-pretty text-foreground";
const ACTION_CLASS =
  "ml-3 underline decoration-dotted underline-offset-2 hover:text-structure-on-canvas focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-structure-on-canvas focus-visible:ring-offset-2";

function Bar({ children }: { children: ReactNode }) {
  return (
    <div className={BAR_CLASS} role="status">
      {children}
    </div>
  );
}

export default function UpdateBanner() {
  const [res, setRes] = useState<CheckResponse | null>(null);
  const [checking, setChecking] = useState(false);
  const [dismissedSha, setDismissedShaState] = useState<string | null>(null);
  const [appliedDismissed, setAppliedDismissed] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  async function check() {
    setChecking(true);
    try {
      const r = await fetch("/api/updates");
      if (r.ok) setRes(await r.json());
    } catch {
      /* offline / unreachable — leave the last known state showing */
    } finally {
      setChecking(false);
    }
  }

  useEffect(() => {
    if (!isFlagEnabled("update_check")) return;
    setDismissedShaState(getDismissedSha());
    check();
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (res?.state !== "applying") {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
      return;
    }
    if (pollRef.current) return;
    pollRef.current = setInterval(check, 3000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [res?.state]);

  async function handleUpdateNow() {
    try {
      await fetch("/api/updates/apply", { method: "POST" });
    } catch {
      /* best-effort — the follow-up check() reflects whatever the server state actually is */
    }
    await check();
  }

  if (!isFlagEnabled("update_check")) return null;
  // Brief, bounded "Checking…" flash for the very first check only — never shown pre-hydration
  // (checking starts false, and only an effect flips it), so there's no flash on first paint.
  if (checking && res === null) return <Bar>Checking for updates…</Bar>;
  if (!shouldShowBanner(res)) return null;

  if (res.state === "update-available") {
    if (res.remoteSha === dismissedSha) return null;
    return (
      <Bar>
        An update is available.
        <button type="button" onClick={handleUpdateNow} className={ACTION_CLASS}>
          Update now
        </button>
        <button
          type="button"
          onClick={() => {
            setDismissedSha(res.remoteSha);
            setDismissedShaState(res.remoteSha);
          }}
          className={ACTION_CLASS}
        >
          Dismiss
        </button>
      </Bar>
    );
  }

  if (res.state === "applying") {
    return <Bar>{res.phase === "installing" ? "Installing dependencies…" : "Pulling the latest code…"}</Bar>;
  }

  if (res.state === "applied") {
    // Not persisted (unlike the update-available dismiss): restarting the server — which this
    // message asks the user to do — resets the in-memory applyState back to idle, so there is no
    // "SHA" to remember here. This only suppresses the nag for the rest of the current session.
    if (appliedDismissed) return null;
    return (
      <Bar>
        Updated. Restart the server (Ctrl+C, then <code>npm start</code>) to use it.
        <button type="button" onClick={() => setAppliedDismissed(true)} className={ACTION_CLASS}>
          Dismiss
        </button>
      </Bar>
    );
  }

  // apply-failed
  return (
    <Bar>
      Update failed: {res.message}
      <button type="button" onClick={handleUpdateNow} className={ACTION_CLASS}>
        Retry
      </button>
    </Bar>
  );
}
