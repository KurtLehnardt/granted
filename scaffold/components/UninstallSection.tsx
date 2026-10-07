"use client";

import React, { useEffect, useState } from "react";
import type { AppUninstallInfo } from "@/app/api/app/uninstall/handler";
import type { UninstallOutcome } from "@/lib/appUpdate/install";
import ReportProblemLink from "@/components/ReportProblemLink";
import { reportClientError } from "@/lib/errorLog/client";
import { isErrorId } from "@/lib/errorLog/errorId";

/**
 * The bottom of Settings → About Granted on macOS: Uninstall Granted.
 *
 * Windows users uninstall Granted from Windows' own "Installed apps" list, so
 * nothing is shown there (the API answers canUninstall: false, reason
 * "not-macos"); macOS has no such list, which is why the work order asks for
 * uninstall here and in the menu-bar menu.
 *
 * Nothing is deleted from this component. Everything it knows comes from
 * scripts/macos/uninstall.sh --check, and the uninstall itself is that same
 * script run with --quiet: this is the asking, in front of the person doing it,
 * and nowhere else. Two things have to be true before the button that starts it
 * is enabled — the question was asked, and, if the folder holds work that isn't
 * on GitHub, that was shown and acknowledged on its own. The server checks both
 * again before it starts anything.
 *
 * Nor is a started uninstall reported as a finished one. The server answers as
 * soon as the script is running, and the script can still refuse after that —
 * it stops before deleting anything when the folder's parent can't be written
 * to, or when the copy of the API keys couldn't be made — leaving Granted
 * installed and running. So "started" is what this says, and it then polls
 * (?check=0) for what the uninstaller actually did, the way AppUpdateSection
 * polls for the restart after an update. The usual outcome is no answer at all:
 * the uninstall stops this server, so the page stops working. That is success.
 *
 * `initialInfo` and `initialStage` are the hermetic test seams (no network, and
 * a stage renderable without a click), as in AppUpdateSection and ModelSection.
 */
export type UninstallStage =
  | { id: "idle" }
  | { id: "confirm" }
  | { id: "starting" }
  | { id: "started"; backupDir: string | null }
  | { id: "refused"; outcome: UninstallOutcome }
  | { id: "error"; message: string; errorId?: string };

/** How often the page asks what the uninstaller it started has decided. */
const POLL_MS = 2000;

/** Whether the uninstall may be started: unsaved work has to be acknowledged separately. */
export function uninstallAllowed(opts: { unsaved: string[]; acknowledged: boolean }): boolean {
  return opts.unsaved.length === 0 || opts.acknowledged;
}

/**
 * An uninstall that stopped without removing Granted, in words — from the
 * script's own reason, which is the only thing that knows what happened.
 *
 * The two move failures are stated as "nothing was deleted" because the script
 * guarantees exactly that: it moves the folder aside before it deletes
 * anything, so a move that failed has changed nothing and can be retried.
 */
export function uninstallRefusalMessage(outcome: UninstallOutcome): string {
  switch (outcome.reason) {
    case "access-denied":
      return "macOS wouldn't let this account move or delete Granted's folder, so nothing was deleted. Granted is still installed.";
    case "files-in-use":
      return "Granted's folder couldn't be moved, so nothing was deleted. Close anything using it — a terminal open in there, say — and try again.";
    case "unsaved-work":
      return "Granted's folder has work that isn't saved to GitHub, so nothing was deleted.";
    case "cancelled":
      return "The uninstall was cancelled, so nothing was deleted.";
    default:
      return "The uninstall stopped before it finished, so Granted may still be installed.";
  }
}

/**
 * The request body for one choice. `force` is not a second switch the user
 * sets: it is the acknowledgement of the unsaved work, and it is never sent
 * when there is none.
 */
export function uninstallRequest(opts: { keepKeys: boolean; unsaved: string[] }): {
  action: "uninstall";
  keepKeys: boolean;
  force: boolean;
} {
  return { action: "uninstall", keepKeys: opts.keepKeys, force: opts.unsaved.length > 0 };
}

export default function UninstallSection({
  initialInfo,
  initialStage,
}: {
  initialInfo?: AppUninstallInfo;
  initialStage?: UninstallStage;
}) {
  const [info, setInfo] = useState<AppUninstallInfo | null>(initialInfo ?? null);
  const [stage, setStage] = useState<UninstallStage>(initialStage ?? { id: "idle" });
  const [keepKeys, setKeepKeys] = useState(true);
  const [acknowledged, setAcknowledged] = useState(false);

  useEffect(() => {
    if (initialInfo) return;
    fetch("/api/app/uninstall")
      .then((r) => (r.ok ? r.json() : null))
      .then((i: AppUninstallInfo | null) => i && setInfo(i))
      .catch(() => {});
  }, [initialInfo]);

  // What the uninstaller decided after it was started. A fetch that fails is
  // the expected end of this: the uninstall stopped the server. Only an
  // uninstaller that says it removed nothing changes what is on screen — there
  // is something to tell the user then, and something to do about it.
  useEffect(() => {
    if (stage.id !== "started") return;
    let stopped = false;
    const timer = setInterval(() => {
      void fetch("/api/app/uninstall?check=0")
        .then((r) => (r.ok ? r.json() : null))
        .then((body: AppUninstallInfo | null) => {
          const outcome = body?.outcome;
          if (stopped || !outcome || outcome.removed) return;
          setStage({ id: "refused", outcome });
        })
        .catch(() => {});
    }, POLL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [stage.id]);

  async function handleUninstall(): Promise<void> {
    if (!info) return;
    setStage({ id: "starting" });
    try {
      const res = await fetch("/api/app/uninstall", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(uninstallRequest({ keepKeys, unsaved: info.unsaved })),
      });
      const body = (await res.json().catch(() => ({}))) as { started?: boolean; keptKeys?: string | null; error?: string; errorId?: string };
      if (!body.started) {
        setStage({
          id: "error",
          message: body.error ?? "Couldn't start the uninstall.",
          errorId: isErrorId(body.errorId) ? body.errorId : undefined,
        });
        return;
      }
      setStage({ id: "started", backupDir: body.keptKeys ?? null });
    } catch (err) {
      setStage({ id: "error", message: "Couldn't start the uninstall.", errorId: reportClientError("app-uninstall", err) });
    }
  }

  // Nothing at all where uninstalling from here isn't a thing: Windows (its own
  // Installed apps list), a developer's own checkout, an install too old to
  // have the script.
  if (!info?.canUninstall) return null;

  const legendClass = "font-mono text-[11px] uppercase tracking-eyebrow text-foreground";
  const textClass = "mt-1.5 font-body text-[12px] text-foreground opacity-80";
  const dangerBtnClass =
    "inline-flex min-h-[44px] items-center rounded-sm border border-error px-4 py-2 font-mono text-[11px] uppercase tracking-eyebrow text-foreground transition hover:bg-error hover:text-token-white active:scale-[0.98] disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-structure-on-canvas focus-visible:ring-offset-2";
  const plainBtnClass =
    "inline-flex min-h-[44px] items-center rounded-sm border border-structure-on-canvas px-4 py-2 font-mono text-[11px] uppercase tracking-eyebrow text-structure-on-canvas transition hover:bg-structure hover:text-token-white active:scale-[0.98] disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-structure-on-canvas focus-visible:ring-offset-2";

  return (
    <div className="mt-5 border-t border-structure-on-canvas pt-4" data-testid="app-uninstall">
      <span className={legendClass}>Uninstall Granted</span>

      {stage.id === "idle" && (
        <>
          <p className={textClass} data-testid="app-uninstall-note">
            Removes Granted from this Mac: {info.installDir}, its menu-bar icon, the Granted launcher in your
            Applications folder, and its settings and logs. Git and Node stay installed.
          </p>
          <div className="mt-2">
            <button type="button" onClick={() => setStage({ id: "confirm" })} className={dangerBtnClass}>
              Uninstall Granted
            </button>
          </div>
        </>
      )}

      {stage.id === "confirm" && (
        <div
          className="mt-2 rounded-r-sm border-l-2 border-error bg-canvas-alt px-3 py-2"
          role="group"
          aria-label="Confirm uninstalling Granted"
          data-testid="app-uninstall-confirm"
        >
          <p className="font-body text-[13px] text-foreground">
            Uninstall Granted? This deletes {info.installDir} and everything in it. Granted closes while it happens,
            and this page stops working.
          </p>

          {info.unsaved.length > 0 && (
            <div className="mt-2" data-testid="app-uninstall-unsaved">
              <p className="font-body text-[13px] text-foreground">
                This folder has work that isn&apos;t saved to GitHub, and uninstalling deletes it permanently:
              </p>
              <ul className="mt-1 list-disc pl-5 font-body text-[12px] text-foreground">
                {info.unsaved.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
              <label className="mt-1.5 flex items-center gap-2 font-body text-[13px] text-foreground">
                <input type="checkbox" checked={acknowledged} onChange={(e) => setAcknowledged(e.target.checked)} />
                Delete that work too
              </label>
            </div>
          )}

          {info.keyFiles.length > 0 && (
            <label className="mt-2 flex items-center gap-2 font-body text-[13px] text-foreground">
              <input type="checkbox" checked={keepKeys} onChange={(e) => setKeepKeys(e.target.checked)} />
              Keep a copy of my API keys and settings
            </label>
          )}
          {info.keyFiles.length > 0 && keepKeys && (
            <p className={textClass} data-testid="app-uninstall-backup">
              The copy goes to {info.backupDir}
            </p>
          )}

          <div className="mt-3 flex flex-wrap items-center gap-3">
            <button type="button" onClick={() => setStage({ id: "idle" })} className={plainBtnClass}>
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void handleUninstall()}
              disabled={!uninstallAllowed({ unsaved: info.unsaved, acknowledged })}
              className={dangerBtnClass}
            >
              Uninstall Granted now
            </button>
          </div>
        </div>
      )}

      {stage.id === "starting" && (
        <p className={textClass} aria-live="polite">
          Starting the uninstall…
        </p>
      )}

      {stage.id === "started" && (
        <p className={textClass} aria-live="polite" data-testid="app-uninstall-started">
          An uninstall was started. Granted closes while it runs, so this page stops working in a moment — you can close
          the window. If the uninstaller stops without removing anything, it says so here.
          {stage.backupDir ? ` A copy of your API keys and settings is going to ${stage.backupDir}.` : ""}
        </p>
      )}

      {stage.id === "refused" && (
        <div className="mt-2" aria-live="polite" data-testid="app-uninstall-refused">
          <p className="font-body text-[13px] text-foreground">{uninstallRefusalMessage(stage.outcome)}</p>
          {stage.outcome.detail && <p className={textClass}>{stage.outcome.detail}</p>}
          {stage.outcome.keptKeys && (
            <p className={textClass}>A copy of your API keys and settings is in {stage.outcome.keptKeys}.</p>
          )}
          <div className="mt-2">
            <button type="button" onClick={() => setStage({ id: "idle" })} className={plainBtnClass}>
              Back
            </button>
          </div>
        </div>
      )}

      {stage.id === "error" && (
        <>
          <p className={textClass} aria-live="polite" data-testid="app-uninstall-error">
            {stage.message}
          </p>
          {stage.errorId && (
            <p className="mt-1">
              <ReportProblemLink errorId={stage.errorId} area="app-uninstall" message={stage.message} />
            </p>
          )}
        </>
      )}
    </div>
  );
}
