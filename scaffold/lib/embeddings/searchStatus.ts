import { activeSearchSpace, type SearchEmbeddingsSetting, type SpaceId } from "./spaces";
import { builtinModelStatus, type BuiltinModelStatus } from "./builtin";
import { builtinBackfillStatus, startBuiltinVectorBackfill, type BackfillStatus } from "./backfill";
import { getCorpusInfo, type CorpusInfo } from "../corpus/store";

/**
 * What Settings → Model shows on its "Search" line (GET /api/llm, GET
 * /api/llm/embeddings): which embedding space search uses right now, why, the
 * built-in model's download state, and how much of the corpus that space can
 * search by similarity.
 */
export interface SearchStatus {
  space: SpaceId;
  /** "Built-in, on this computer", "OpenAI embeddings", or the custom-embedder label. */
  label: string;
  model: string;
  /** Why this space was chosen (e.g. "No OpenAI key", "SEARCH_EMBEDDINGS=openai"). */
  reason: string;
  setting: SearchEmbeddingsSetting;
  /** The built-in model's files: ready, missing, downloading (with progress) or failed. */
  builtin: BuiltinModelStatus;
  /** Records with a vector in this space, of all records; plus any background indexing of the rest. */
  coverage?: { withVectors: number; total: number; backfill?: BackfillStatus };
  /** Why the store passed over the data:refresh copy, if it did. */
  note?: string;
}

/** Whether records lack built-in vectors and a background run should fill them in. */
export function needsBuiltinBackfill(info: Pick<CorpusInfo, "space" | "withVectors" | "opportunities">): boolean {
  return info.space.id === "builtin" && info.withVectors < info.opportunities.length;
}

export function buildSearchStatus(
  deps: {
    builtin?: () => BuiltinModelStatus;
    corpus?: () => Pick<CorpusInfo, "space" | "withVectors" | "opportunities" | "note"> | null;
    backfill?: () => BackfillStatus;
    startBackfill?: () => void;
  } = {},
): SearchStatus {
  const { space, reason, setting } = activeSearchSpace();
  let info: Pick<CorpusInfo, "space" | "withVectors" | "opportunities" | "note"> | null = null;
  try {
    info = (deps.corpus ?? getCorpusInfo)();
  } catch {
    info = null; // the status line must never fail because the corpus couldn't be read
  }
  if (info && needsBuiltinBackfill(info)) {
    (deps.startBackfill ?? (() => void startBuiltinVectorBackfill()))();
  }
  const backfill = (deps.backfill ?? builtinBackfillStatus)();
  return {
    space: space.id,
    label: space.label,
    model: space.id === "custom" ? process.env.EMBEDDINGS_MODEL || "custom" : space.model,
    reason,
    setting,
    builtin: (deps.builtin ?? builtinModelStatus)(),
    ...(info && info.space.id === space.id
      ? {
          coverage: {
            withVectors: info.withVectors,
            total: info.opportunities.length,
            ...(backfill.running || backfill.error ? { backfill } : {}),
          },
        }
      : {}),
    ...(info?.note ? { note: info.note } : {}),
  };
}
