import type { Opportunity } from "../types";

/**
 * Hybrid retrieval (instant-cards perf work) — a small BM25 keyword index over
 * the cached corpus, fused with the existing embedding cosine rank (see
 * `hybrid.ts`). Pure, dependency-light, no LLM/embedding/network. Built lazily
 * and cached by corpus array IDENTITY (a `WeakMap`), so it's rebuilt only when
 * the corpus store actually reloads (`CorpusStore.load()` hands back a new
 * array reference on a real reload, the same cached reference otherwise) or a
 * caller passes a fresh fixture array (hermetic tests).
 */

const STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "but", "if", "then", "than", "so", "of", "to",
  "in", "on", "for", "with", "by", "at", "as", "is", "are", "was", "were",
  "be", "been", "being", "this", "that", "these", "those", "it", "its",
  "from", "into", "over", "under", "up", "down", "out", "not", "no", "nor",
  "we", "you", "your", "our", "their", "his", "her", "he", "she", "they",
  "will", "shall", "may", "can", "could", "would", "should", "must", "also",
  "any", "all", "each", "such", "which", "who", "whom", "what", "when",
  "where", "how", "do", "does", "did", "have", "has", "had", "there",
]);

/** Lowercase, split on non-alphanumerics, drop stopwords and single chars. No stemming — deliberate simplicity/exactness tradeoff (an exact keyword must still hit). */
export function tokenize(text: string): string[] {
  if (!text) return [];
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

/** The text BM25 indexes for one opportunity: program/agency/description/eligibility. */
export function opportunityText(o: Opportunity): string {
  return [o.program, o.agency, o.description, o.eligibility].filter(Boolean).join(" ");
}

export interface BM25Index {
  ids: string[];
  /** term -> (docIdx -> term frequency in that doc). Postings list — only docs containing the term. */
  postings: Map<string, Map<number, number>>;
  docLengths: number[];
  avgDocLength: number;
  df: Map<string, number>;
  n: number;
}

export const BM25_K1 = 1.5;
export const BM25_B = 0.75;

export function buildBM25Index(corpus: Opportunity[]): BM25Index {
  const ids: string[] = new Array(corpus.length);
  const docLengths: number[] = new Array(corpus.length);
  const postings = new Map<string, Map<number, number>>();
  const df = new Map<string, number>();
  let totalLength = 0;

  for (let i = 0; i < corpus.length; i++) {
    const o = corpus[i];
    ids[i] = o.id;
    const tokens = tokenize(opportunityText(o));
    docLengths[i] = tokens.length;
    totalLength += tokens.length;

    const tf = new Map<string, number>();
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
    for (const [term, freq] of Array.from(tf.entries())) {
      let p = postings.get(term);
      if (!p) {
        p = new Map();
        postings.set(term, p);
      }
      p.set(i, freq);
      df.set(term, (df.get(term) ?? 0) + 1);
    }
  }

  return {
    ids,
    postings,
    docLengths,
    avgDocLength: corpus.length > 0 ? totalLength / corpus.length : 0,
    df,
    n: corpus.length,
  };
}

const indexCache = new WeakMap<Opportunity[], BM25Index>();

/** Lazily builds and caches the index by the corpus array's reference — invalidated whenever the caller hands in a new array (a real corpus-store reload, or a fresh test fixture). */
export function getBM25Index(corpus: Opportunity[]): BM25Index {
  let idx = indexCache.get(corpus);
  if (!idx) {
    idx = buildBM25Index(corpus);
    indexCache.set(corpus, idx);
  }
  return idx;
}

export interface BM25Hit {
  id: string;
  score: number;
}

/** Ranks documents by Okapi BM25 relevance to `queryText`. Only touches docs whose postings contain at least one query term — O(query terms x postings length), fast even at 20k docs. Returns hits sorted score desc, ties broken by id for determinism. */
export function bm25Query(index: BM25Index, queryText: string, limit = Infinity): BM25Hit[] {
  const terms = Array.from(new Set(tokenize(queryText)));
  if (terms.length === 0 || index.n === 0) return [];

  const scores = new Map<number, number>();
  for (const term of terms) {
    const postings = index.postings.get(term);
    if (!postings) continue;
    const df = index.df.get(term) ?? 0;
    const idf = Math.log((index.n - df + 0.5) / (df + 0.5) + 1);
    if (idf <= 0) continue;
    for (const [docIdx, tf] of Array.from(postings.entries())) {
      const docLen = index.docLengths[docIdx];
      const denom = tf + BM25_K1 * (1 - BM25_B + (BM25_B * docLen) / (index.avgDocLength || 1));
      const s = (idf * (tf * (BM25_K1 + 1))) / (denom || 1);
      scores.set(docIdx, (scores.get(docIdx) ?? 0) + s);
    }
  }

  const hits: BM25Hit[] = Array.from(scores.entries()).map(([docIdx, score]) => ({
    id: index.ids[docIdx],
    score,
  }));
  hits.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return limit === Infinity ? hits : hits.slice(0, limit);
}
