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
