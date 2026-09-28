import type { Match, Opportunity } from "@/lib/types";

/** A retrieved-but-not-yet-scored card: no score/tier, rendered with a spinner. */
export type ProvisionalMatch = { opportunity: Opportunity; provisional: true };

/** Everything the streamed preview list can hold: a provisional retrieval hit, or a fully scored (Pass A or Pass B) Match. */
export type PreviewItem = ProvisionalMatch | Match;

export function isProvisional(p: PreviewItem): p is ProvisionalMatch {
  return (p as ProvisionalMatch).provisional === true;
}

/**
 * Upserts a streamed preview item (a provisional retrieval hit, a Pass-A
 * score, or a Pass-B narrative) by opportunity id, updating the EXISTING
 * card's data in place without moving its position in the list — cards must
 * never jump around while they're still being scored. A new id is appended at
 * the end, in the order it arrives (retrieval-rank order for provisional
 * hits, arrival order for anything scored out of retrieval order).
 *
 * Nothing is ever removed here, including a final tier-"none" score — a
 * provisional card must never vanish abruptly. The caller partitions a
 * tier-"none" item into a separate "More matches" section instead (see
 * `partitionPreview` below); this reducer only tracks the accumulated set.
 *
 * A stale provisional event that arrives AFTER a real score for the same id
 * (a straggling retrieval echo, or an out-of-order network delivery) is
 * ignored — a spinner must never overwrite a real score.
 */
export function previewReducer(prev: PreviewItem[], m: PreviewItem): PreviewItem[] {
  const id = m.opportunity.id;
  const idx = prev.findIndex((p) => p.opportunity.id === id);
  if (idx === -1) return [...prev, m];

  const existing = prev[idx];
  if (isProvisional(m) && !isProvisional(existing)) return prev;

  const next = prev.slice();
  next[idx] = m;
  return next;
}

/**
 * Splits an accumulated preview list into the main shown set and the ONE
 * "More matches" collapsed set — mirrors `OpportunityMap`'s
 * `selectShownMatches` for the streaming view (§2, never-vanish list), so a
 * candidate never just disappears once it stops fitting the main list.
 *
 * A still-provisional card (no score yet) keeps the exact slot it already
 * has — it is NOT ranked against scored cards. Only the scored items among
 * `candidates` are ranked (by score, descending) and slotted back into the
 * positions scored items occupy, highest score first; every provisional
 * item's own position is left untouched. A final tier-"none" score, or an
 * unscored candidate, goes into `weaker` outright. `cap` bounds the main list
 * the same way the finished map does (CARD_CAP); pass it explicitly to avoid
 * this module depending on the component tree.
 */
export function partitionPreview(
  items: PreviewItem[],
  cap: number,
): { shown: PreviewItem[]; weaker: PreviewItem[] } {
  const candidates: PreviewItem[] = [];
  const weaker: PreviewItem[] = [];
  for (const it of items) {
    if (!isProvisional(it) && (it.unscored || it.tier === "none")) {
      weaker.push(it);
    } else {
      candidates.push(it);
    }
  }

  const scoredSorted = candidates
    .filter((it): it is Match => !isProvisional(it))
    .sort((a, b) => b.score - a.score);
  let si = 0;
  const merged = candidates.map((it) => (isProvisional(it) ? it : scoredSorted[si++]));

  return { shown: merged.slice(0, cap), weaker: [...merged.slice(cap), ...weaker] };
}
