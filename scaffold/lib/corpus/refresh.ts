import type { Opportunity } from "../types";

/** Must match scripts/3-embed.mjs so reused vectors stay comparable. */
export function opportunityEmbedText(o: Pick<Opportunity, "program" | "agency" | "description">): string {
  return `${o.program}. ${o.agency}. ${o.description}`.slice(0, 8000);
}

/** Model of the committed corpus, which predates `embeddingModel` in its meta. */
export const LEGACY_EMBEDDING_MODEL = "text-embedding-3-small";

export interface PriorEmbeddingEntry {
  embedding: number[];
  text: string;
}

export interface EmbeddingPlan {
  reused: Opportunity[];
  toEmbed: Opportunity[];
  added: number;
  updated: number;
  fullReembed: boolean;
}

/** Reuses a prior vector only when the model, the embedded text and (if given) the dimensionality all match. */
export function planEmbedding(
  incoming: Opportunity[],
  priorById: Map<string, PriorEmbeddingEntry>,
  priorModel: string | undefined,
  currentModel: string,
  dims?: number,
): EmbeddingPlan {
  const fullReembed = (priorModel || LEGACY_EMBEDDING_MODEL) !== currentModel;
  const reused: Opportunity[] = [];
  const toEmbed: Opportunity[] = [];
  let added = 0;
  let updated = 0;
  for (const o of incoming) {
    const prior = fullReembed ? undefined : priorById.get(o.id);
    const text = opportunityEmbedText(o);
    const dimsOk = dims == null || prior?.embedding.length === dims;
    if (prior && prior.text === text && Array.isArray(prior.embedding) && prior.embedding.length > 0 && dimsOk) {
      reused.push({ ...o, embedding: prior.embedding });
    } else {
      toEmbed.push(o);
      if (priorById.has(o.id)) updated++;
      else added++;
    }
  }
  return { reused, toEmbed, added, updated, fullReembed };
}

export function countRemoved(priorIds: Iterable<string>, finalIds: Set<string>): number {
  let removed = 0;
  Array.from(priorIds).forEach((id) => {
    if (!finalIds.has(id)) removed++;
  });
  return removed;
}

export function countBySource(records: { source: string }[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const r of records) counts[r.source] = (counts[r.source] ?? 0) + 1;
  return counts;
}

/** Flags sources (of 5+ prior records) that shrank below `dropThreshold`, e.g. a fetcher that swallowed an outage. */
export function findUnhealthySources(
  prior: Record<string, number>,
  fresh: Record<string, number>,
  dropThreshold = 0.5,
): string[] {
  const issues: string[] = [];
  for (const [source, priorCount] of Object.entries(prior)) {
    if (priorCount < 5) continue;
    const freshCount = fresh[source] ?? 0;
    if (freshCount < priorCount * dropThreshold) {
      issues.push(`${source}: had ${priorCount}, now ${freshCount}`);
    }
  }
  return issues;
}

/** Last occurrence wins. */
export function dedupeById(records: Opportunity[]): Opportunity[] {
  const byId = new Map<string, Opportunity>();
  for (const o of records) byId.set(o.id, o);
  return Array.from(byId.values());
}

/**
 * A user stop mid-embedding still needs a coherent corpus written: reused records (unchanged,
 * already embedded) plus whatever finished embedding before the stop. A record that hadn't been
 * embedded yet is dropped from this save UNLESS it already had a cached version from before —
 * that prior version is kept as-is, so a stop never loses already-cached data.
 *
 * Only safe to call for a PARTIAL re-embed (some records were reused under the current model).
 * During a full re-embed, `priorById`'s vectors are from the OLD model — see computeStopOutcome.
 */
export function mergePartialSave(
  reused: Opportunity[],
  embeddedSoFar: Opportunity[],
  notYetEmbedded: Opportunity[],
  priorById: Map<string, Opportunity>,
): Opportunity[] {
  const out = [...reused, ...embeddedSoFar];
  const seen = new Set(out.map((o) => o.id));
  for (const o of notYetEmbedded) {
    if (seen.has(o.id)) continue;
    const prior = priorById.get(o.id);
    if (prior) {
      out.push(prior);
      seen.add(o.id);
    }
  }
  return out;
}

export interface StopOutcome {
  /** Whether the corpus file should be (re)written at all. */
  save: boolean;
  /** Only meaningful when `save` is true. */
  corpus: Opportunity[];
  status: { lastCompletedAt: string; stopped: true; savedCount: number };
}

/**
 * What a user Stop should write, given where in the pipeline it landed.
 *
 * - Before embedding ever started: the corpus is left untouched.
 * - During a FULL re-embed (embedding model changed, so `reused` is empty): a not-yet-embedded
 *   record has no same-model prior vector to fall back to. Falling back to its old cached
 *   version anyway (as a plain merge would) writes a corpus that mixes two embedding models
 *   under one `embeddingModel` label — lib/match.ts reads corpusDim from the first record only,
 *   so the other-dimensioned vectors silently get NaN cosine and drop out of retrieval, and
 *   nothing repairs it until the next full refresh. So this case is treated like a stop before
 *   embedding: the corpus is left untouched.
 * - During a PARTIAL re-embed: reused + embedded-so-far + any not-yet-embedded record's still-
 *   valid (same-model) prior vector are merged and saved.
 */
export function computeStopOutcome(params: {
  attemptAt: string;
  duringEmbedding: boolean;
  fullReembed: boolean;
  reused: Opportunity[];
  embeddedSoFar: Opportunity[];
  notYetEmbedded: Opportunity[];
  priorById: Map<string, Opportunity>;
}): StopOutcome {
  const { attemptAt, duringEmbedding, fullReembed, reused, embeddedSoFar, notYetEmbedded, priorById } = params;
  if (!duringEmbedding || fullReembed) {
    return { save: false, corpus: [], status: { lastCompletedAt: attemptAt, stopped: true, savedCount: 0 } };
  }
  const corpus = mergePartialSave(reused, embeddedSoFar, notYetEmbedded, priorById);
  return { save: true, corpus, status: { lastCompletedAt: attemptAt, stopped: true, savedCount: corpus.length } };
}
