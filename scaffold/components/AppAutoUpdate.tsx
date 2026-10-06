"use client";

import { useEffect, useState } from "react";
import { waitForUpdate } from "@/components/useAppUpdate";

/**
 * Automatic updates (Settings → "Install updates automatically"): when
 * Granted is opened, asks the server whether to update now. It decides — on
 * only if the box is ticked, this install can update itself, a check is due
 * (not on every page load) and a newer release exists — and starts the
 * updater. Then this shows what's happening while Granted restarts, and
 * reloads on the new version.
 */
export default function AppAutoUpdate() {
  const [updating, setUpdating] = useState<{ to: string; error?: string } | null>(null);

  useEffect(() => {
    if (typeof navigator !== "undefined" && !navigator.onLine) return;
    (async () => {
      try {
        const res = await fetch("/api/app/update", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "auto" }),
        });
        const body = (await res.json().catch(() => ({}))) as { started?: boolean; to?: string; startedAt?: string };
        if (!body.started || !body.to) return;
        const to = body.to;
        setUpdating({ to });
        const outcome = await waitForUpdate(to, body.startedAt ?? null);
        if (outcome.ok) window.location.reload();
        else setUpdating({ to, error: outcome.message });
      } catch {
        /* best-effort: never in the way of using Granted */
      }
    })();
  }, []);

  if (!updating) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="app-auto-update"
      className="fixed inset-x-0 top-0 z-[60] border-b border-structure-on-canvas bg-canvas px-4 py-3 text-center font-body text-[13px] text-foreground shadow-overlay"
    >
      {updating.error ? (
        <>
          {updating.error}{" "}
          <button type="button" className="underline underline-offset-2" onClick={() => setUpdating(null)}>
            Dismiss
          </button>
        </>
      ) : (
        <>Updating Granted to {updating.to}… Granted will close and reopen by itself, and this page reloads when it's back.</>
      )}
    </div>
  );
}
