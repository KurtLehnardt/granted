"use client";
// Explicit React import — see the note in components/ApplicationChecklist.tsx.
import React, { useState } from "react";
import OpportunityCard from "./OpportunityCard";
import type { Match, StartupProfile } from "@/lib/types";
import { isProvisional, type PreviewItem } from "@/lib/ui/previewReducer";

/**
 * "More matches" (§2, never-vanish list): everything that doesn't make the
 * main list — a tier-"none" candidate, a real match ranked past CARD_CAP, or a
 * candidate that couldn't be scored at all (§1) — is a real fit judgment the
 * search actually made, so it collapses into this ONE section instead of
 * disappearing. Collapsed by default (so it never competes with the main
 * opportunity map for attention); a toggle expands it. Identically during
 * streaming (app/page.tsx) and in the finished map (OpportunityMap.tsx) — one
 * component, one behavior.
 */
export default function WeakerMatches({
  matches,
  startupProfile,
}: {
  matches: PreviewItem[];
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
        More matches ({matches.length})
      </button>
      {open && (
        <div className="mt-4 space-y-3">
          {matches.map((m, i) =>
            !isProvisional(m) && m.unscored ? (
              <CouldntScoreCard key={m.opportunity?.id ?? i} m={m} />
            ) : (
              <OpportunityCard key={m.opportunity?.id ?? i} m={m} index={99} startupProfile={startupProfile} />
            ),
          )}
        </div>
      )}
    </section>
  );
}

/** §1 — a provisional id that survived retrieval but genuinely never got a
 *  score (a dropped batch, an unresolved model id). Never a fake number: a
 *  plain "Couldn't score" label instead of the usual match-percentage badge. */
function CouldntScoreCard({ m }: { m: Match }) {
  const o = m.opportunity;
  return (
    <article className="relative overflow-hidden rounded-lg bg-canvas-alt text-foreground shadow-card">
      <span className="spine bg-structure-on-canvas" aria-hidden />
      <div className="flex flex-wrap items-start justify-between gap-4 px-5 py-4 sm:flex-nowrap sm:gap-6 sm:px-6 sm:py-5">
        <div className="min-w-0">
          <h3 className="mt-1.5 text-balance font-display text-[19px] font-medium leading-snug text-foreground">
            {o.program}
          </h3>
          <p className="mt-1 text-pretty font-mono text-[12px] text-foreground">{o.agency}</p>
        </div>
        <div className="shrink-0 text-right">
          <span className="inline-block rounded-sm bg-canvas-alt px-2 py-0.5 font-mono text-[11px] uppercase tracking-eyebrow text-structure-on-canvas">
            Couldn&rsquo;t score
          </span>
        </div>
      </div>
    </article>
  );
}
