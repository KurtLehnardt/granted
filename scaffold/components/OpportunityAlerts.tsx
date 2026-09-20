"use client";
import { useEffect, useState } from "react";
import type { OpportunityMap as MapT } from "@/lib/types";
import { computeProfileKey } from "@/lib/alerts/profileKey";
import { diffOpportunities } from "@/lib/alerts/diff";
import { loadAlertSnapshot, saveAlertSnapshot } from "@/lib/alerts/store";
import type { AlertItem } from "@/lib/alerts/types";

/**
 * D5 — "Opportunity Alerts": a client-only diff of this run's opportunity map
 * against the snapshot saved from the user's last visit for the SAME
 * profile/search (see lib/alerts/profileKey.ts), surfacing what's new or
 * changed since then — new matches, tier upgrades, and newly closing-soon
 * deadlines.
 *
 * §5.3 "no server retention": the snapshot lives ONLY in localStorage on this
 * device (lib/alerts/store.ts). Nothing here ever calls fetch or an API
 * route. Gated behind the default-OFF `d5_alerts` flag by the single
 * insertion point in OpportunityMap.tsx; all the logic lives in this
 * component + lib/alerts/*.
 *
 * SSR-safe: starts with an empty alert list (same as "no prior snapshot")
 * and hydrates after mount — same pattern as AppSidebar's grants/descriptions
 * local stores (see lib/localStore.ts's header comment).
 */

function eyebrowClass(extra = "") {
  return `font-mono text-[11px] uppercase tracking-eyebrow text-structure-on-canvas ${extra}`.trim();
}

const KIND_LABEL: Record<AlertItem["kind"], string> = {
  new: "New match",
  tier_upgrade: "Upgraded",
  closing_soon: "Closing soon",
};

export default function OpportunityAlerts({ map }: { map: MapT }) {
  const [alerts, setAlerts] = useState<AlertItem[]>([]);

  useEffect(() => {
    if (!map || typeof map !== "object") return;
    const profileKey = computeProfileKey(map.profile);
    const previous = loadAlertSnapshot();
    const { alerts: nextAlerts, nextSnapshot } = diffOpportunities(previous, profileKey, map.matches);
    setAlerts(nextAlerts);
    saveAlertSnapshot(nextSnapshot);
    // Intentionally runs once per mounted map: re-diffing on every render
    // would immediately re-save the current state as its own baseline and
    // the diff would always read empty. A new `map` (a fresh search) is the
    // only thing that should trigger a fresh diff.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map]);

  if (alerts.length === 0) return null;

  return (
    <section className="mt-8 rounded-lg border border-structure-on-canvas bg-canvas-alt px-6 py-5 shadow-card">
      <p className={eyebrowClass("mb-3")}>Since your last visit</p>
      <ul className="space-y-2">
        {alerts.map((a) => (
          <li
            key={`${a.kind}-${a.opportunityId}`}
            className="text-pretty font-body text-[14px] text-foreground"
          >
            <span className={eyebrowClass("mr-2")}>{KIND_LABEL[a.kind]}</span>
            {a.title}
            {a.agency ? ` — ${a.agency}` : ""}
            {a.kind === "tier_upgrade" && a.previousTier ? ` (was ${a.previousTier})` : ""}
          </li>
        ))}
      </ul>
    </section>
  );
}
