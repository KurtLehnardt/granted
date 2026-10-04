"use client";

import React, { useId } from "react";

export type StateSourceOption = { id: string; label: string; note?: string };

// California/Illinois/North Carolina are the established, on-by-default state
// sources (real APIs/HTML directories). Utah is a 4th, opt-in source: its
// only public listing is a Looker Studio BI dashboard (needs a full headless
// browser to read, unlike the other three), and the data itself is weaker —
// see its note below, shown so enabling it is an informed choice.
export const STATE_SOURCE_OPTIONS: StateSourceOption[] = [
  { id: "ca-grants", label: "California" },
  { id: "il-grants", label: "Illinois" },
  { id: "nc-grants", label: "North Carolina" },
  {
    id: "ut-grants",
    label: "Utah",
    note: "Weaker data: no deadlines, no eligibility info, and occasional overlap with federal listings the state is just highlighting.",
  },
];

/**
 * Settings' "which states should we fetch" control (new — previously every
 * state source was fetched unconditionally, with no on/off concept at all).
 * Extracted as its own sub-component the same way ModelSection.tsx was
 * extracted out of SettingsForm.tsx — its own file, default export, local
 * style constants, mounted directly in SettingsForm's JSX.
 *
 * Unlike ModelSection (which round-trips to a server endpoint and commits
 * via its own internal Save/Test/Remove buttons), persisting a selection
 * change here is a pure client-side localStorage write — so, like
 * maxCandidates/autoUpdate/maxCorpusSize right next to it in SettingsForm,
 * this is a CONTROLLED component: the draft array lives in SettingsForm's
 * own state and is committed by SettingsForm's single Save button
 * (lib/searchSettings.ts's setSelectedStateSources), not by this component.
 */
export default function StateSourcesSection({
  selected,
  onChange,
}: {
  selected: string[];
  onChange: (next: string[]) => void;
}) {
  const uid = useId();

  function toggle(id: string) {
    onChange(selected.includes(id) ? selected.filter((s) => s !== id) : [...selected, id]);
  }

  const legendClass = "font-mono text-[11px] uppercase tracking-eyebrow text-foreground";
  const fieldWrapClass = "mt-5 border-t border-structure-on-canvas pt-4 first:mt-4 first:border-t-0 first:pt-0";
  const optionLabelClass = "flex cursor-pointer items-start gap-2 font-body text-[14px] text-foreground";
  const optionInputClass = "mt-0.5 h-4 w-4 shrink-0 accent-structure";

  return (
    <div className={fieldWrapClass} data-testid="state-sources-section">
      <span className={legendClass}>State grant sources</span>
      <p className="mt-1.5 font-body text-[12px] text-foreground opacity-80">
        Which state grant directories to fetch. A change here takes effect on the next data refresh, not
        instantly.
      </p>
      <div className="mt-3 flex flex-col gap-2.5" role="group" aria-label="State grant sources">
        {STATE_SOURCE_OPTIONS.map((opt) => {
          const inputId = `${uid}-state-source-${opt.id}`;
          return (
            <div key={opt.id}>
              <label htmlFor={inputId} className={optionLabelClass}>
                <input
                  type="checkbox"
                  id={inputId}
                  checked={selected.includes(opt.id)}
                  onChange={() => toggle(opt.id)}
                  className={optionInputClass}
                  data-testid={`state-source-${opt.id}`}
                />
                {opt.label}
              </label>
              {opt.note && <p className="ml-6 mt-0.5 font-body text-[12px] text-foreground opacity-70">{opt.note}</p>}
            </div>
          );
        })}
      </div>
    </div>
  );
}
