import { CARD_CAP } from "@/components/OpportunityMap";
import type { Match } from "@/lib/types";

/**
 * Reduce one streamed preview `Match` into the running preview list. Two-pass
 * local scoring re-emits the SAME opportunity twice: first with just its
 * Pass-A score (no narrative), then again once Pass B finishes its narrative —
 * update the existing card in place rather than duplicating it.
 *
 * Kept SORTED by score (desc) and capped at `CARD_CAP` by EVICTING the
 * lowest-scored card, rather than keeping whichever cards happened to arrive
 * first. Pass A streams every candidate in retrieval (cosine) order, so a
 * first-come cap would freeze on the first 8 arrivals and never make room for
 * a higher-scoring later one — this way the preview converges toward the same
 * top-N-by-score set the finished map settles on.
 */
export function previewReducer(prev: Match[], m: Match): Match[] {
  const existingIndex = prev.findIndex((p) => p.opportunity.id === m.opportunity.id);
  let next: Match[];
  if (existingIndex !== -1) {
    // A re-emit can also drop the card below tier "none" if Pass B never
    // promoted it — remove it, same as it never having appeared.
    if (m.tier === "none") return prev.filter((_, i) => i !== existingIndex);
    next = prev.slice();
    next[existingIndex] = m;
  } else {
    // A "none"-tier match would never make the finished map's card list
    // either (OpportunityMap filters the same way) — skip it here so the
    // preview never shows a card that's about to vanish once scoring finishes.
    if (m.tier === "none") return prev;
    next = [...prev, m];
  }
  next.sort((a, b) => b.score - a.score);
  return next.length > CARD_CAP ? next.slice(0, CARD_CAP) : next;
}
