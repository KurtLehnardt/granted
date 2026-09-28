"use client";

import { scoreDescription, type StrengthBand } from "@/lib/descriptionStrength";

/**
 * Strength meter under the company-description box.
 *
 * It is a NUDGE, not a gate: nothing here blocks a search, because a short
 * description still returns real programs (measured — a nine-word one retrieved
 * three on-topic farm programs). What a short description costs you is ranking
 * quality and, on a local model, a long wait to find that out. So the meter's
 * job is to say "this will do better with more" BEFORE the user spends the wait.
 *
 * The band is length; see lib/descriptionStrength.ts for what that trades away.
 *
 * COLOR (CON-02 / contrast): the band colors are carried by the segment FILLS
 * only. Text stays `text-foreground`, never a semantic color inline — warning
 * and success fills fail AA as text at this size, which is exactly what
 * scripts/design/contrast-check.mjs flags "DO NOT USE". Fill + `text-on-semantic`
 * is the pattern EligibilityBuckets.tsx already uses.
 */

const BAND_LABEL: Record<StrengthBand, string> = {
  weak: "Short",
  fair: "Workable",
  strong: "Strong",
};

/** Fill for each lit segment. Fills only — see the CON-02 note above. */
const BAND_FILL: Record<StrengthBand, string> = {
  weak: "bg-error",
  fair: "bg-warning",
  strong: "bg-success",
};

const SEGMENTS_LIT: Record<StrengthBand, number> = { weak: 1, fair: 2, strong: 3 };

export function DescriptionStrength({ value, id }: { value: string; id?: string }) {
  const text = (value ?? "").trim();
  // Nothing typed yet: stay silent rather than greeting an empty box with a
  // red bar. The placeholder is already doing the prompting at that point.
  if (!text) return null;

  const { band, suggestions } = scoreDescription(text);
  const lit = SEGMENTS_LIT[band];

  return (
    <div id={id} className="mt-2">
      <div className="flex items-center gap-2">
        <div className="flex gap-1" aria-hidden="true">
          {[0, 1, 2].map((i) => (
            <span
              key={i}
              className={`h-1.5 w-8 rounded-sm ${i < lit ? BAND_FILL[band] : "bg-structure-on-canvas opacity-25"}`}
            />
          ))}
        </div>
        <span className="font-mono text-[11px] uppercase tracking-eyebrow text-foreground">
          {BAND_LABEL[band]}
        </span>
      </div>

      {/*
        The bars are decorative (aria-hidden); the band word beside them and the
        suggestions below are real visible text, so a screen reader already gets
        the substance in normal reading order.
        This live region therefore announces ONLY the band word. An earlier
        version put the score and every suggestion in here, which re-announced
        the whole block on each keystroke — the region's content changed
        constantly, so it fired constantly. Limiting it to the band means it
        speaks on the three transitions that are actually news.
      */}
      <p className="sr-only" aria-live="polite">
        Description strength: {BAND_LABEL[band]}
      </p>

      {suggestions.length > 0 && (
        <ul className="mt-1.5 space-y-1">
          {suggestions.map((s) => (
            <li
              key={s}
              className="text-pretty font-body text-[12px] leading-relaxed text-foreground opacity-80"
            >
              {s}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default DescriptionStrength;
