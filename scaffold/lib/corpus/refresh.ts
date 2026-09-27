import type { Opportunity } from "../types";

/** The exact text embedded per opportunity — must match scripts/3-embed.mjs
 *  and lib/embed.ts's query-side shape so cached vectors stay comparable. */
export function opportunityEmbedText(o: Pick<Opportunity, "program" | "agency" | "description">): string {
  return `${o.program}. ${o.agency}. ${o.description}`.slice(0, 8000);
}

/** The committed corpus predates the `embeddingModel` meta field; it was
 *  built with this model, so an untagged prior corpus is assumed to be it. */
export const LEGACY_EMBEDDING_MODEL = "text-embedding-3-small";

export interface PriorEmbeddingEntry {
  embedding: number[];
  text: string;
}

export interface EmbeddingPlan {
  /** Records that keep their existing embedding, id/text/model all matched. */
  reused: Opportunity[];
  /** Records that need a fresh embedding call. */
  toEmbed: Opportunity[];
  /** New ids not present in the prior corpus. */
  added: number;
  /** Existing ids whose embed text (or the model) changed. */
  updated: number;
  /** True when the configured model differs from the prior corpus's — every
   *  record is re-embedded rather than matched by id. */
  fullReembed: boolean;
}

/**
 * Incremental-embedding decision: reuse a prior embedding only when the id,
 * the exact embedded text, and the embedding model are all unchanged. A
 * model change forces every record through `toEmbed` regardless of id/text.
 */
export function planEmbedding(
  incoming: Opportunity[],
  priorById: Map<string, PriorEmbeddingEntry>,
  priorModel: string | undefined,
  currentModel: string,
): EmbeddingPlan {
  const fullReembed = (priorModel || LEGACY_EMBEDDING_MODEL) !== currentModel;
  const reused: Opportunity[] = [];
  const toEmbed: Opportunity[] = [];
  let added = 0;
  let updated = 0;
  for (const o of incoming) {
    const prior = fullReembed ? undefined : priorById.get(o.id);
    const text = opportunityEmbedText(o);
    if (prior && prior.text === text && Array.isArray(prior.embedding) && prior.embedding.length > 0) {
      reused.push({ ...o, embedding: prior.embedding });
    } else {
      toEmbed.push(o);
      if (priorById.has(o.id)) updated++;
      else added++;
    }
  }
  return { reused, toEmbed, added, updated, fullReembed };
}

/** Ids present in the prior corpus but absent from the freshly assembled one
 *  (a source dropped the record, or it expired). */
export function countRemoved(priorIds: Iterable<string>, finalIds: Set<string>): number {
  let removed = 0;
  Array.from(priorIds).forEach((id) => {
    if (!finalIds.has(id)) removed++;
  });
  return removed;
}

/** Dedup a freshly-assembled record list by id — the last occurrence wins
 *  (later sources in the assembly order are the more specific normalizers). */
export function dedupeById(records: Opportunity[]): Opportunity[] {
  const byId = new Map<string, Opportunity>();
  for (const o of records) byId.set(o.id, o);
  return Array.from(byId.values());
}
