"use client";
import { useMemo, useState } from "react";
import OpportunityCard from "./OpportunityCard";
import type { Match, StartupProfile } from "@/lib/types";
import type { OpportunityKind } from "@/lib/contracts/opportunity";
import {
  availableKinds,
  filterByKinds,
  groupMatchesByKind,
  KIND_LABEL,
} from "@/lib/opportunities/group";

/**
 * C1b — user-facing type filters + map grouping by instrument kind.
 *
 * Rendered by `OpportunityMap.tsx` in place of the flat card list ONLY when the
 * `c1b_type_groups` flag is on (default off, so the flat list stays the
 * baseline). All grouping/filter LOGIC lives in `lib/opportunities/group.ts`
 * (pure, hermetically tested); this component is the thin client shell that owns
 * the filter state and renders `OpportunityCard`s — deliberately isolating the
 * one shared hot file (`OpportunityMap.tsx`) from this feature's surface area.
 */

/** Shared "eyebrow"-style mono label (matches OpportunityMap/AgencyMap). */
function eyebrowClass(extra = "") {
  return `font-mono text-[11px] uppercase tracking-eyebrow text-structure-on-canvas ${extra}`.trim();
}

function chipClass(active: boolean) {
  // Token-driven (no raw hex): active chips take the navy structure fill with
  // white content (same pairing as the header/nav); inactive chips are a hairline
  // outline on the canvas.
  return active
    ? "rounded-full bg-structure px-3 py-1 font-mono text-[11px] uppercase tracking-eyebrow text-token-white"
    : "rounded-full border border-structure-on-canvas bg-canvas-alt px-3 py-1 font-mono text-[11px] uppercase tracking-eyebrow text-foreground";
}

export default function OpportunityGroups({
  matches,
  startupProfile,
}: {
  matches: Match[];
  startupProfile?: StartupProfile;
}) {
  const kinds = useMemo(() => availableKinds(matches), [matches]);
  // `null` = "All" (no filter). Otherwise a single selected kind.
  const [active, setActive] = useState<OpportunityKind | null>(null);

  // If the selected kind is no longer present (props changed), fall back to All.
  const effectiveActive = active && kinds.includes(active) ? active : null;

  const filtered = useMemo(
    () => filterByKinds(matches, effectiveActive ? [effectiveActive] : null),
    [matches, effectiveActive],
  );
  const groups = useMemo(() => groupMatchesByKind(filtered), [filtered]);

  const countByKind = useMemo(() => {
    const counts = new Map<OpportunityKind, number>();
    for (const g of groupMatchesByKind(matches)) counts.set(g.kind, g.matches.length);
    return counts;
  }, [matches]);

  if (!Array.isArray(matches) || matches.length === 0) return null;

  // A running index across all rendered cards so the first few stay expanded
  // (OpportunityCard opens when index < 3), preserving the flat list's behavior.
  let cardIndex = 0;

  return (
    <div>
      {/* Type filters — only offered for kinds actually present. A single-select
          All / one-kind toggle: the clearest user-facing "show me only X". */}
      {kinds.length > 1 && (
        <div role="group" aria-label="Filter opportunities by type" className="mb-5 flex flex-wrap gap-2">
          <button
            type="button"
            aria-pressed={effectiveActive === null}
            onClick={() => setActive(null)}
            className={chipClass(effectiveActive === null)}
          >
            All ({matches.length})
          </button>
          {kinds.map((k) => (
            <button
              key={k}
              type="button"
              aria-pressed={effectiveActive === k}
              onClick={() => setActive(k)}
              className={chipClass(effectiveActive === k)}
            >
              {KIND_LABEL[k]} ({countByKind.get(k) ?? 0})
            </button>
          ))}
        </div>
      )}

      {/* Grouped sections — one per present kind, in canonical order. */}
      <div className="space-y-8">
        {groups.map((group) => (
          <section key={group.kind}>
            <p className={eyebrowClass("mb-3")}>
              {group.label} · {group.matches.length}
            </p>
            <div className="space-y-3">
              {group.matches.map((m) => (
                <OpportunityCard
                  key={m.opportunity?.id ?? cardIndex}
                  m={m}
                  index={cardIndex++}
                  startupProfile={startupProfile}
                />
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
