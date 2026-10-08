"use client";
// Explicit React import: needed under the plain `tsx`-run node:test runner
// (this repo's tsconfig `"jsx": "preserve"` falls back to the classic JSX
// runtime there) — see the same note in components/ApplicationChecklist.tsx.
import React, { useMemo, useState } from "react";
import OpportunityCard from "./OpportunityCard";
import OpportunityGroups from "./OpportunityGroups";
import type { Match, StartupProfile } from "@/lib/types";
import { isFlagEnabled } from "@/lib/flags";
import { availableLocations, filterByLocation, sortMatches, type SortKey } from "@/lib/opportunities/filterSort";

/**
 * Match-results filter/sort control: location, match %, award amount,
 * recency.
 *
 * Rendered by `OpportunityMap.tsx` in place of the flat list / OpportunityGroups
 * unless the `match_filters` flag is explicitly set to false. All filter/sort LOGIC
 * lives in `lib/opportunities/filterSort.ts` (pure, hermetically tested); this
 * component is the thin client shell that owns the control state and feeds the
 * filtered+sorted array into the SAME rendering path `OpportunityMap.tsx`
 * already uses (the `c1b_type_groups` kind-filter chips, or the flat list) —
 * so the two filter controls stack orthogonally without either file knowing
 * about the other's state.
 *
 * Sort and Location are independent, not a package deal: Sort by match %/
 * award/recency is useful on ANY result set and always shows once there's
 * more than one match. Location only shows once at least one of the current
 * matches actually carries a `geography` (a state-source record) -- most
 * searches are federal-dominated and carry none, which used to hide the
 * WHOLE row, Sort included (REGRESSION, found live: a flag-enabled user saw
 * neither control on an all-federal result set).
 */

function eyebrowClass(extra = "") {
  return `font-mono text-[11px] uppercase tracking-eyebrow text-structure-on-canvas ${extra}`.trim();
}

function selectClass() {
  return "rounded-sm border border-structure-on-canvas bg-canvas-alt px-2.5 py-1.5 font-mono text-[11px] uppercase tracking-eyebrow text-foreground";
}

const SORT_LABEL: Record<SortKey, string> = {
  match: "Match %",
  award: "Award amount",
  recency: "Recently added",
};

/** If the selected location is no longer present (e.g. `matches` prop
 * changed under the user), fall back to "Any" (`null`) rather than holding
 * a stale/invalid filter. Exported for direct unit testing — pure, no
 * React dependency. */
export function resolveEffectiveLocation(selected: string | null, available: string[]): string | null {
  return selected && available.includes(selected) ? selected : null;
}

export default function OpportunityFilters({
  matches,
  startupProfile,
}: {
  matches: Match[];
  startupProfile?: StartupProfile;
}) {
  const locations = useMemo(() => availableLocations(matches), [matches]);
  // `null` = "Any location" (no filter).
  const [location, setLocation] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>("match");

  const effectiveLocation = resolveEffectiveLocation(location, locations);

  const filtered = useMemo(() => filterByLocation(matches, effectiveLocation), [matches, effectiveLocation]);
  const sorted = useMemo(() => sortMatches(filtered, sortKey), [filtered, sortKey]);

  if (!Array.isArray(matches) || matches.length === 0) return null;

  return (
    <div>
      <div className="mb-5 flex flex-wrap items-end gap-4">
        {locations.length > 0 && (
          <label className="flex flex-col gap-1">
            <span className={eyebrowClass()}>Location</span>
            <select
              value={effectiveLocation ?? ""}
              onChange={(e) => setLocation(e.target.value || null)}
              className={selectClass()}
            >
              <option value="">Any location</option>
              {locations.map((loc) => (
                <option key={loc} value={loc}>
                  {loc}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="flex flex-col gap-1">
          <span className={eyebrowClass()}>Sort by</span>
          <select value={sortKey} onChange={(e) => setSortKey(e.target.value as SortKey)} className={selectClass()}>
            {(Object.keys(SORT_LABEL) as SortKey[]).map((key) => (
              <option key={key} value={key}>
                {SORT_LABEL[key]}
              </option>
            ))}
          </select>
        </label>
      </div>

      {isFlagEnabled("c1b_type_groups") ? (
        <OpportunityGroups matches={sorted} startupProfile={startupProfile} />
      ) : (
        <div className="space-y-3">
          {sorted.map((m, i) => (
            <OpportunityCard key={m.opportunity?.id ?? i} m={m} index={i} startupProfile={startupProfile} />
          ))}
        </div>
      )}
    </div>
  );
}
