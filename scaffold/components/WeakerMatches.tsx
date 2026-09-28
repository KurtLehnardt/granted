"use client";
import { useState } from "react";
import OpportunityCard from "./OpportunityCard";
import type { Match, StartupProfile } from "@/lib/types";

/**
 * Weaker matches (instant-cards §4): a tier-"none" candidate is no longer
 * silently hidden — it's a real fit judgment the search actually made, so it
 * collapses into this section instead of disappearing. Collapsed by default
 * (so it never competes with the real opportunity map for attention); a
 * toggle expands it. Same during streaming (app/page.tsx) and in the finished
 * map (OpportunityMap.tsx) — one component, one behavior.
 */
export default function WeakerMatches({
  matches,
  startupProfile,
}: {
  matches: Match[];
  startupProfile?: StartupProfile;
}) {
  const [open, setOpen] = useState(false);
  if (matches.length === 0) return null;

  return (
    <section className="mt-6">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-eyebrow text-structure-on-canvas"
      >
        <span aria-hidden className={`inline-block transition-transform ${open ? "rotate-90" : ""}`}>
          ▶
        </span>
        Weaker matches ({matches.length})
      </button>
      {open && (
        <div className="mt-4 space-y-3">
          {matches.map((m, i) => (
            <OpportunityCard key={m.opportunity?.id ?? i} m={m} index={99} startupProfile={startupProfile} />
          ))}
        </div>
      )}
    </section>
  );
}
