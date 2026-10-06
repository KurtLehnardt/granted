import { resolveProvider, type ProviderName } from "../llm/config";
import { SPACES, parseSearchEmbeddingsSetting, resolveSpaceId } from "../../scripts/lib/spaces.mjs";

/**
 * Typed view of the embedding-space registry in scripts/lib/spaces.mjs (kept
 * there so bare-node scripts share it), plus the app's wiring of the resolution
 * rule to the real environment and Settings.
 */

export type SpaceId = "openai" | "builtin" | "custom";
export type SearchEmbeddingsSetting = "auto" | "builtin" | "openai";

export interface EmbeddingSpace {
  id: SpaceId;
  /** What Settings → Model shows on its "Search" line. */
  label: string;
  model: string;
  dims: number | undefined;
  /** Below this cosine similarity a program is never a candidate (models differ in scale). */
  candidateFloor: number;
  /** Fewer strong matches than this makes a weak field. */
  weakFieldThreshold: number;
  queryPrefix: string;
  documentPrefix: string;
  backend: "http" | "inprocess";
  /** "inline": opportunities.json's `embedding` field; "file": data/vectors/<name>.{f16.bin,json}. */
  vectors: { kind: "inline" } | { kind: "file"; name: string };
  /** What cost metering records as the provider of this space's embeddings. */
  meterProvider: "openai" | "builtin" | "custom";
}

export const EMBEDDING_SPACES = SPACES as unknown as Record<SpaceId, EmbeddingSpace>;

export function getSpace(id: SpaceId): EmbeddingSpace {
  return EMBEDDING_SPACES[id];
}

export interface SpaceInputs {
  setting?: string;
  provider: ProviderName;
  openAiKey?: string;
  embeddingsBaseUrl?: string;
  embeddingsModel?: string;
  embeddingsDimensions?: string;
}

export interface ResolvedSpace {
  space: EmbeddingSpace;
  reason: string;
  setting: SearchEmbeddingsSetting;
}

/** Pure: which space search uses for these inputs (see scripts/lib/spaces.mjs for the rule). */
export function resolveSearchSpace(input: SpaceInputs): ResolvedSpace {
  const { id, reason } = resolveSpaceId(input) as { id: SpaceId; reason: string };
  return { space: getSpace(id), reason, setting: parseSearchEmbeddingsSetting(input.setting) as SearchEmbeddingsSetting };
}

/** The real inputs: SEARCH_EMBEDDINGS, the Local/Cloud switch, the OpenAI key and EMBEDDINGS_BASE_URL, read on every call. */
export function currentSpaceInputs(): SpaceInputs {
  return {
    setting: process.env.SEARCH_EMBEDDINGS,
    provider: resolveProvider(),
    openAiKey: process.env.EMBEDDINGS_API_KEY || process.env.OPENAI_API_KEY,
    embeddingsBaseUrl: process.env.EMBEDDINGS_BASE_URL,
    embeddingsModel: process.env.EMBEDDINGS_MODEL,
    embeddingsDimensions: process.env.EMBEDDINGS_DIMENSIONS,
  };
}

/** The space search uses right now. */
export function activeSearchSpace(): ResolvedSpace {
  return resolveSearchSpace(currentSpaceInputs());
}
