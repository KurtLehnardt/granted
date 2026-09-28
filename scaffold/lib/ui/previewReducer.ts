import { CARD_CAP } from "@/components/OpportunityMap";
import type { Match } from "@/lib/types";

/** Upserts a streamed preview by id (two-pass re-emits a card once narrated), keeping the top `CARD_CAP` by score. Tier `none` never shows. */
export function previewReducer(prev: Match[], m: Match): Match[] {
  const existingIndex = prev.findIndex((p) => p.opportunity.id === m.opportunity.id);
  let next: Match[];
  if (existingIndex !== -1) {
    if (m.tier === "none") return prev.filter((_, i) => i !== existingIndex);
    next = prev.slice();
    next[existingIndex] = m;
  } else {
    if (m.tier === "none") return prev;
    next = [...prev, m];
  }
  next.sort((a, b) => b.score - a.score);
  return next.length > CARD_CAP ? next.slice(0, CARD_CAP) : next;
}
