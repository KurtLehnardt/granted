"use client";

import React, { useEffect, useState } from "react";
import type { AppUpdateInfo } from "@/app/api/app/update/handler";
import { waitForUpdate } from "@/components/useAppUpdate";
import { isNewerRelease } from "@/lib/appUpdate/releases";
import ReportProblemLink from "@/components/ReportProblemLink";
import { reportClientError } from "@/lib/errorLog/client";
import { isErrorId } from "@/lib/errorLog/errorId";

/**
 * The bottom of Settings: this install's version, "Check for updates", and
 * "Install updates automatically". An install made by the Windows installer
 * updates itself (scripts/windows/update.ps1 — Granted restarts, and this
 * page reloads on the new version); anything else is told what's available
 * and where to get it.
 *
 * `initialInfo` is the hermetic test seam (no network), as in ModelSection.
 */
type CheckState =
  | { id: "idle" }
  | { id: "checking" }
  | { id: "starting" }
  | { id: "updating"; to: string }
  | { id: "error"; message: string; errorId?: string };

export default function AppUpdateSection({ initialInfo }: { initialInfo?: AppUpdateInfo }) {
  const [info, setInfo] = useState<AppUpdateInfo | null>(initialInfo ?? null);
  const [checked, setChecked] = useState(false);
  const [state, setState] = useState<CheckState>({ id: "idle" });

  useEffect(() => {
    if (initialInfo) return;
    // Opening Settings: the version straight away, no GitHub request.
    fetch("/api/app/update?check=0")
      .then((r) => (r.ok ? r.json() : null))
      .then((i: AppUpdateInfo | null) => i && setInfo(i))
      .catch(() => {});
  }, [initialInfo]);

  async function handleCheck() {
    setState({ id: "checking" });
    try {
      const res = await fetch("/api/app/update?check=force");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setInfo(await res.json());
      setChecked(true);
      setState({ id: "idle" });
    } catch (err) {
      setState({ id: "error", message: "Couldn't check for updates.", errorId: reportClientError("app-update", err) });
    }
  }

  async function handleUpdate() {
    // Disables the buttons at once: a second click must not start a second update.
    setState({ id: "starting" });
    try {
      const res = await fetch("/api/app/update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "install" }),
      });
      const body = (await res.json().catch(() => ({}))) as { started?: boolean; to?: string; startedAt?: string; error?: string; errorId?: string };
      if (!body.started || !body.to) {
        setState({ id: "error", message: body.error ?? "Granted is already up to date.", errorId: isErrorId(body.errorId) ? body.errorId : undefined });
        return;
      }
      setState({ id: "updating", to: body.to });
      const outcome = await waitForUpdate(body.to, body.startedAt ?? null);
      if (outcome.ok) window.location.reload();
      else setState({ id: "error", message: outcome.message, errorId: reportClientError("app-update", outcome.message) });
    } catch (err) {
      setState({ id: "error", message: "Couldn't start the update.", errorId: reportClientError("app-update", err) });
    }
  }

  async function handleAutoUpdate(next: boolean) {
    setInfo((i) => (i ? { ...i, autoUpdate: next } : i));
    try {
      const res = await fetch("/api/app/update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "settings", autoUpdate: next }),
      });
      if (!res.ok) throw new Error();
    } catch {
      setInfo((i) => (i ? { ...i, autoUpdate: !next } : i));
      setState({ id: "error", message: "Couldn't save that setting." });
    }
  }

  const legendClass = "font-mono text-[11px] uppercase tracking-eyebrow text-foreground";
  const textClass = "mt-1.5 font-body text-[12px] text-foreground opacity-80";
  const btnClass =
    "inline-flex min-h-[44px] items-center rounded-sm border border-structure-on-canvas px-4 py-2 font-mono text-[11px] uppercase tracking-eyebrow text-structure-on-canvas transition hover:bg-structure hover:text-token-white active:scale-[0.98] disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-structure-on-canvas focus-visible:ring-offset-2";
  const busy = state.id === "checking" || state.id === "starting" || state.id === "updating";

  return (
    <div className="mt-5 border-t border-structure-on-canvas pt-4" data-testid="app-update">
      <span className={legendClass}>About Granted</span>
      <p className="mt-1.5 font-body text-[13px] text-foreground" data-testid="app-version">
        Granted {info ? `v${info.version}` : ""}
      </p>

      <div className="mt-2 flex flex-wrap items-center gap-3">
        <button type="button" onClick={handleCheck} disabled={busy} className={btnClass}>
          {state.id === "checking" ? "Checking…" : "Check for updates"}
        </button>
        {info?.updateAvailable && info.canUpdate && state.id !== "updating" && state.id !== "starting" && (
          <button type="button" onClick={handleUpdate} className={btnClass}>
            Update to {info.latest}
          </button>
        )}
      </div>

      <p className={textClass} aria-live="polite" data-testid="app-update-note">
        {noteFor(info, checked, state)}
      </p>
      {state.id === "error" && state.errorId && (
        <p className="mt-1">
          <ReportProblemLink errorId={state.errorId} area="app-update" message={state.message} />
        </p>
      )}

      {info?.canUpdate && (
        <label className="mt-3 flex items-center gap-2 font-body text-[13px] text-foreground">
          <input
            type="checkbox"
            checked={info.autoUpdate}
            disabled={busy}
            onChange={(e) => handleAutoUpdate(e.target.checked)}
          />
          Install updates automatically
        </label>
      )}
    </div>
  );
}

/** What to say under the buttons. */
export function noteFor(info: AppUpdateInfo | null, checked: boolean, state: CheckState): React.ReactNode {
  if (state.id === "starting") return "Starting the update…";
  if (state.id === "updating") return `Updating Granted to ${state.to}… Granted will close and reopen by itself, and this page reloads when it's back.`;
  if (state.id === "error") return state.message;
  if (!info) return "";
  // The last update's outcome — only while it's still news (an error whose
  // target isn't installed yet; a success that's what's running).
  const current = `v${info.version}`;
  if (info.status?.state === "error" && isNewerRelease(info.status.to ?? null, current)) return info.status.message ?? "The last update didn't finish.";
  if (!checked) return info.status?.state === "done" && info.status.to === current ? `Updated to Granted ${current}.` : "";
  if (info.checkFailed) return "Couldn't reach GitHub to check for updates. Try again later.";
  if (!info.updateAvailable) return "You're up to date.";
  if (info.canUpdate) return `Granted ${info.latest} is available.`;
  if (info.reason === "not-installer-made") return `Granted ${info.latest} is available. This is a developer checkout: update it with git pull.`;
  return (
    <>
      Granted {info.latest} is available —{" "}
      <a href={info.releasesPage} target="_blank" rel="noreferrer" className="underline underline-offset-2">
        download it from the releases page
      </a>
      .
    </>
  );
}
