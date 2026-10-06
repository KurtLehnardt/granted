/**
 * Embedding spaces. A search compares a query vector with corpus vectors, and
 * that only means something when both came from the same model with the same
 * conventions. Each space names one such model plus everything that goes with
 * it: its vector size, the similarity floor below which a program is never a
 * candidate, the prefixes the model expects on queries and documents, how it
 * runs (an HTTP embeddings API, or in this process), and where its corpus
 * vectors live.
 *
 *   openai   OpenAI text-embedding-3-small at 512 dims, over HTTP. Vectors are
 *            stored inline in opportunities.json (the original format).
 *   builtin  nomic-embed-text-v1.5, run in this process from scaffold/models/.
 *            Vectors are in data/vectors/nomic-embed-text-v1.5.{f16.bin,json}.
 *            The same vectors Ollama's nomic-embed-text produces, so Local
 *            (Ollama) users search this corpus too.
 *   custom   whatever EMBEDDINGS_BASE_URL / EMBEDDINGS_MODEL point at (a setup
 *            from before the built-in model existed). Vectors inline, from the
 *            user's own `npm run data:embed:local`.
 *
 * Plain .mjs so bare-node scripts (3-embed.mjs) share it; the app imports it
 * through lib/embeddings/spaces.ts.
 */

/** Similarity floors and weak-field thresholds are per space: cosine scales differ between models. */
export const SPACES = {
  openai: {
    id: "openai",
    label: "OpenAI embeddings",
    model: "text-embedding-3-small",
    dims: 512,
    // The shipped calibration (see CALIBRATION in lib/match.ts).
    candidateFloor: 0.22,
    weakFieldThreshold: 1,
    queryPrefix: "",
    documentPrefix: "",
    backend: "http",
    vectors: { kind: "inline" },
    meterProvider: "openai",
  },
  builtin: {
    id: "builtin",
    label: "Built-in, on this computer",
    model: "nomic-embed-text-v1.5",
    dims: 768,
    // Calibrated from the corpus's own similarity distribution (no API calls):
    // with programs used as queries, OpenAI's 0.22 floor admits 97.4% of the
    // corpus; 0.53 admits the same share of built-in query-to-program cosines,
    // which run higher (median 0.62). Every strong match in the four demo
    // searches sits at 0.61 or above. Re-check with `npm run eval:builtin`.
    candidateFloor: 0.53,
    weakFieldThreshold: 1,
    queryPrefix: "search_query: ",
    documentPrefix: "search_document: ",
    backend: "inprocess",
    vectors: { kind: "file", name: "nomic-embed-text-v1.5" },
    meterProvider: "builtin",
  },
  custom: {
    id: "custom",
    label: "Your embedding server (.env.local)",
    model: "custom",
    dims: undefined,
    candidateFloor: 0.22,
    weakFieldThreshold: 1,
    queryPrefix: "",
    documentPrefix: "",
    backend: "http",
    vectors: { kind: "inline" },
    meterProvider: "custom",
  },
};

export const SEARCH_EMBEDDINGS_VALUES = ["auto", "builtin", "openai"];

/** SEARCH_EMBEDDINGS, normalised; anything unrecognised counts as "auto". */
export function parseSearchEmbeddingsSetting(raw) {
  const v = String(raw ?? "").trim().toLowerCase();
  return SEARCH_EMBEDDINGS_VALUES.includes(v) ? v : "auto";
}

/** Same shape rule the app uses for OpenAI keys (lib/llm/providers.ts): sk-, 20-200 chars, no whitespace, not the placeholder. */
export function looksLikeOpenAiKey(key) {
  const k = String(key ?? "").trim();
  return k.length >= 20 && k.length <= 200 && !/\s/.test(k) && k.startsWith("sk-") && !k.startsWith("sk-...");
}

/** EMBEDDINGS_BASE_URL set to something other than OpenAI: the user runs their own embedder. */
export function hasCustomEmbedder(embeddingsBaseUrl) {
  const url = String(embeddingsBaseUrl ?? "").trim();
  return url !== "" && !/api\.openai\.com/i.test(url);
}

/**
 * Which space search uses. Pure: every input is explicit.
 *
 *   SEARCH_EMBEDDINGS=openai   -> openai (needs a key; a missing one is reported when search runs)
 *   SEARCH_EMBEDDINGS=builtin  -> builtin
 *   auto (the default):
 *     EMBEDDINGS_BASE_URL points at your own embedder -> custom (unchanged from before)
 *     Local (Ollama) selected                          -> builtin (Ollama's nomic vectors are the same)
 *     a valid OpenAI key                               -> openai (existing users see no change)
 *     otherwise                                        -> builtin
 *
 * Returns { id, reason } so Settings can say why.
 *
 * @param {{ setting?: string, provider: string, openAiKey?: string, embeddingsBaseUrl?: string }} input
 * @returns {{ id: "openai" | "builtin" | "custom", reason: string }}
 */
export function resolveSpaceId({ setting, provider, openAiKey, embeddingsBaseUrl }) {
  const s = parseSearchEmbeddingsSetting(setting);
  if (s === "openai") return { id: "openai", reason: "SEARCH_EMBEDDINGS=openai" };
  if (s === "builtin") return { id: "builtin", reason: "SEARCH_EMBEDDINGS=builtin" };
  if (hasCustomEmbedder(embeddingsBaseUrl)) return { id: "custom", reason: "EMBEDDINGS_BASE_URL is set" };
  if (provider === "ollama") return { id: "builtin", reason: "Local model selected" };
  if (looksLikeOpenAiKey(openAiKey)) return { id: "openai", reason: "OpenAI key present" };
  return { id: "builtin", reason: "No OpenAI key" };
}
