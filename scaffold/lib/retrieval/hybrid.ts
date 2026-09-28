/**
 * Hybrid retrieval — reciprocal rank fusion (RRF) between the embedding cosine
 * rank and the BM25 keyword rank (see `bm25.ts`). Pure and dependency-light:
 * takes plain ranked-id lists, returns a fused score per id.
 *
 * RRF (not a weighted score blend) is used deliberately: cosine similarity and
 * BM25 scores live on unrelated, un-normalized scales, so summing raw scores
 * would let whichever one happens to have larger magnitude dominate. RRF only
 * looks at each list's RANK, so it fuses cleanly regardless of scale.
 */

export const RRF_K = 60;

/** score(id) = sum over lists containing it of 1/(k + rank), rank 0-based. Ids present in more/higher lists score higher. */
export function reciprocalRankFusion(rankLists: string[][], k: number = RRF_K): Map<string, number> {
  const scores = new Map<string, number>();
  for (const list of rankLists) {
    list.forEach((id, rank) => {
      const s = 1 / (k + rank + 1);
      scores.set(id, (scores.get(id) ?? 0) + s);
    });
  }
  return scores;
}

/**
 * Fuses a cosine-ranked id list with a BM25-ranked id list (already restricted
 * to whatever candidate set the caller cares about — e.g. cosine-floor
 * clearers only) and returns `cosineIds` re-ordered by the fused RRF score,
 * descending. An id absent from `bm25Ids` still gets its cosine-only RRF
 * contribution, so BM25 can only ever PROMOTE — never exclude — a
 * cosine-floor-clearing candidate. Stable: when the fused score ties (e.g.
 * `bm25Ids` is empty, or gives every candidate an identical score), the
 * original `cosineIds` order is preserved exactly.
 */
export function fuseRankings(cosineIds: string[], bm25Ids: string[], k: number = RRF_K): string[] {
  const fused = reciprocalRankFusion([cosineIds, bm25Ids], k);
  return cosineIds
    .map((id, i) => ({ id, i, score: fused.get(id) ?? 0 }))
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .map((x) => x.id);
}
