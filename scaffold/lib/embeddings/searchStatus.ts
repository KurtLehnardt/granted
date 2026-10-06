import { activeSearchSpace, type SearchEmbeddingsSetting, type SpaceId } from "./spaces";
import { builtinModelStatus, type BuiltinModelStatus } from "./builtin";

/**
 * What Settings → Model shows on its "Search" line (GET /api/llm, GET
 * /api/llm/embeddings): which embedding space search uses right now, why, and
 * the built-in model's download state.
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
}

export function buildSearchStatus(deps: { builtin?: () => BuiltinModelStatus } = {}): SearchStatus {
  const { space, reason, setting } = activeSearchSpace();
  return {
    space: space.id,
    label: space.label,
    model: space.id === "custom" ? process.env.EMBEDDINGS_MODEL || "custom" : space.model,
    reason,
    setting,
    builtin: (deps.builtin ?? builtinModelStatus)(),
  };
}
