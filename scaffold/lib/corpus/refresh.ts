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

/**
 * Reuses a prior vector only when the model, the embedded text and (if given) the dimensionality
 * all match. `priorDims` (the corpus's recorded meta.dims) differing from `dims` (this run's
 * target) means EMBEDDINGS_DIMENSIONS changed under the same model — treated like a model change
 * (fullReembed) so a stop mid-run never mixes dimensionalities into the saved corpus.
 */
export function planEmbedding(
  incoming: Opportunity[],
  priorById: Map<string, PriorEmbeddingEntry>,
  priorModel: string | undefined,
  currentModel: string,
  dims?: number,
  priorDims?: number,
  forceFullReembed = false,
): EmbeddingPlan {
  const dimsChanged = dims != null && priorDims != null && priorDims !== dims;
  const fullReembed = (priorModel || LEGACY_EMBEDDING_MODEL) !== currentModel || dimsChanged || forceFullReembed;
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
 * Merges reused + embedded-so-far + not-yet-embedded records' prior cached vectors. Partial
 * re-embed only; a full re-embed's priors are the old model (see computeStopOutcome). When `dims`
 * is given, both `reused` and a not-yet-embedded record's cached vector are only kept if their
 * length matches it — a defense against ever writing a mixed-dimension corpus even if the plan's
 * `fullReembed` flag was wrong (e.g. it trusted a configured dims value the embedder didn't
 * actually return).
 */
export function mergePartialSave(
  reused: Opportunity[],
  embeddedSoFar: Opportunity[],
  notYetEmbedded: Opportunity[],
  priorById: Map<string, Opportunity>,
  dims?: number,
): Opportunity[] {
  const reusedOk = dims == null ? reused : reused.filter((o) => Array.isArray(o.embedding) && o.embedding.length === dims);
  const out = [...reusedOk, ...embeddedSoFar];
  const seen = new Set(out.map((o) => o.id));
  for (const o of notYetEmbedded) {
    if (seen.has(o.id)) continue;
    const prior = priorById.get(o.id);
    const dimsOk = dims == null || (Array.isArray(prior?.embedding) && prior.embedding.length === dims);
    if (prior && dimsOk) {
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
  status: { lastStoppedAt: string; stopped: true; savedCount: number };
}

/**
 * Full re-embed (including a same-model dimensionality change): prior vectors are incompatible,
 * leave corpus untouched. Partial re-embed: merge and save. Never writes lastCompletedAt for a
 * stopped run — lastStoppedAt is a distinct field so a stop never reads back as a successful run.
 */
export function computeStopOutcome(params: {
  attemptAt: string;
  duringEmbedding: boolean;
  fullReembed: boolean;
  reused: Opportunity[];
  embeddedSoFar: Opportunity[];
  notYetEmbedded: Opportunity[];
  priorById: Map<string, Opportunity>;
  dims?: number;
}): StopOutcome {
  const { attemptAt, duringEmbedding, fullReembed, reused, embeddedSoFar, notYetEmbedded, priorById, dims } = params;
  if (!duringEmbedding || fullReembed) {
    return { save: false, corpus: [], status: { lastStoppedAt: attemptAt, stopped: true, savedCount: 0 } };
  }
  const corpus = mergePartialSave(reused, embeddedSoFar, notYetEmbedded, priorById, dims);
  return { save: true, corpus, status: { lastStoppedAt: attemptAt, stopped: true, savedCount: corpus.length } };
}
