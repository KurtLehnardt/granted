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

/** Reuses a prior vector only when model, embedded text and (if given) dims all match; a model or dims change is a full re-embed. */
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

/**
 * Strips sources the user deliberately deselected this run (Settings' per-source
 * toggle, e.g. unchecking Utah) out of a prior-count baseline before it's passed to
 * `findUnhealthySources`. A deselected source's fresh count is intentionally 0 — not
 * a scrape break — so comparing against its old count would otherwise read as exactly
 * the kind of sharp, unexplained drop that guard exists to catch, and abort the whole
 * refresh (including every other source that fetched fine) the first time anyone
 * unchecks a source with 5+ existing records.
 */
export function excludeDeselectedSources(
  priorCounts: Record<string, number>,
  toggleableSources: readonly string[],
  selectedSources: readonly string[],
): Record<string, number> {
  const filtered = { ...priorCounts };
  for (const source of toggleableSources) {
    if (!selectedSources.includes(source)) delete filtered[source];
  }
  return filtered;
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

/** Partial re-embed stop: reused + embedded-so-far + cached priors of the rest, dropping any vector whose length isn't `dims`. */
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
  save: boolean;
  corpus: Opportunity[];
  status: { lastStoppedAt: string; stopped: true; savedCount: number };
}

/** Saves only a stop during a partial re-embed; a full re-embed's priors are incompatible, so the corpus is left untouched. */
export function computeStopOutcome(params: {
  stoppedAt: string;
  duringEmbedding: boolean;
  fullReembed: boolean;
  reused: Opportunity[];
  embeddedSoFar: Opportunity[];
  notYetEmbedded: Opportunity[];
  priorById: Map<string, Opportunity>;
  dims?: number;
}): StopOutcome {
  const { stoppedAt, duringEmbedding, fullReembed, reused, embeddedSoFar, notYetEmbedded, priorById, dims } = params;
  if (!duringEmbedding || fullReembed) {
    return { save: false, corpus: [], status: { lastStoppedAt: stoppedAt, stopped: true, savedCount: 0 } };
  }
  const corpus = mergePartialSave(reused, embeddedSoFar, notYetEmbedded, priorById, dims);
  return { save: true, corpus, status: { lastStoppedAt: stoppedAt, stopped: true, savedCount: corpus.length } };
}

/**
 * Whether a data:refresh embeds built-in vectors: only when search uses a
 * vector-file space (the built-in model). On OpenAI or a custom embedder the
 * refresh never spends CPU on the built-in model; if search switches to it
 * later, the app fills in the missing vectors in the background
 * (lib/embeddings/backfill.ts).
 */
export function refreshEmbedsBuiltinVectors(space: { vectors: { kind: "inline" } | { kind: "file"; name: string } }): boolean {
  return space.vectors.kind === "file";
}
