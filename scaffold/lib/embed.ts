import type { CostMeter } from "./metering/meter";
import { normalizeOpenAiBaseUrl } from "./llm/baseUrl";
import { activeSearchSpace, getSpace, type EmbeddingSpace } from "./embeddings/spaces";
import { embedWithBuiltin } from "./embeddings/builtin";

/**
 * Embeddings, per embedding space (lib/embeddings/spaces.ts). A query and the
 * corpus it is compared with must come from the same space, so a search pins the
 * space of the corpus it loaded (lib/corpus/store.ts) and embeds its query with it.
 *
 *   builtin  nomic-embed-text-v1.5 in this process (lib/embeddings/builtin.ts).
 *            No key, no network once the model is downloaded. The default when
 *            there is no OpenAI key, and always on Local (Ollama).
 *   openai   OpenAI text-embedding-3-small @ 512 dims. The default when a valid
 *            OPENAI_API_KEY is present, so existing setups behave as before.
 *   custom   your own OpenAI-compatible embedder, from EMBEDDINGS_BASE_URL /
 *            EMBEDDINGS_MODEL, over a corpus you re-embedded with it.
 *
 * SEARCH_EMBEDDINGS=auto|builtin|openai chooses (default auto).
 *
 * Env for the HTTP spaces: EMBEDDINGS_BASE_URL / EMBEDDINGS_MODEL /
 * EMBEDDINGS_DIMENSIONS / EMBEDDINGS_API_KEY (falls back to OPENAI_API_KEY).
 */

const ENV_BASE_URL = normalizeOpenAiBaseUrl(process.env.EMBEDDINGS_BASE_URL || "https://api.openai.com/v1");
const ENV_MODEL = process.env.EMBEDDINGS_MODEL || "text-embedding-3-small";
const ENV_IS_OPENAI = /api\.openai\.com/.test(ENV_BASE_URL);
// OpenAI's text-embedding-3-* accept a `dimensions` param (512 matches the corpus);
// local models have a fixed size, so we omit it there.
const ENV_DIMENSIONS = process.env.EMBEDDINGS_DIMENSIONS
  ? Number(process.env.EMBEDDINGS_DIMENSIONS)
  : ENV_IS_OPENAI
    ? 512
    : undefined;
/** The env-configured HTTP embedder (what `data:embed` without --space uses). */
export { ENV_MODEL as EMBEDDINGS_MODEL, ENV_DIMENSIONS as EMBEDDINGS_DIMENSIONS, ENV_IS_OPENAI as EMBEDDINGS_IS_OPENAI };

/** Where an HTTP space's requests go. */
export interface HttpEmbeddingTarget {
  baseUrl: string;
  model: string;
  dimensions?: number;
  isOpenAi: boolean;
}

/** Pure: the HTTP endpoint for an HTTP space ("openai" is always OpenAI's model; "custom" follows env). */
export function httpTargetForSpace(
  space: EmbeddingSpace,
  env: { baseUrl?: string; model?: string; dimensions?: string } = {
    baseUrl: process.env.EMBEDDINGS_BASE_URL,
    model: process.env.EMBEDDINGS_MODEL,
    dimensions: process.env.EMBEDDINGS_DIMENSIONS,
  },
): HttpEmbeddingTarget {
  if (space.id === "openai") {
    return { baseUrl: "https://api.openai.com/v1", model: space.model, dimensions: space.dims, isOpenAi: true };
  }
  const baseUrl = normalizeOpenAiBaseUrl(env.baseUrl || "https://api.openai.com/v1");
  const isOpenAi = /api\.openai\.com/.test(baseUrl);
  const dimensions = env.dimensions ? Number(env.dimensions) : isOpenAi ? 512 : undefined;
  return { baseUrl, model: env.model || "text-embedding-3-small", dimensions, isOpenAi };
}

/**
 * Conservative placeholder detector: real `sk-`/`sk-proj-` keys are dozens of
 * characters, so this only rejects the literal `.env.example` placeholders
 * (or an obviously truncated string) — it must never reject a genuine key.
 */
function isPlaceholderKey(key: string | undefined): boolean {
  if (!key) return true;
  if (key === "sk-..." || key === "sk-ant-...") return true;
  return key.length < 20;
}

/**
 * Pure guard, exported for unit testing: an HTTP request to OpenAI needs a real
 * key. Only reachable when OpenAI embeddings were chosen explicitly
 * (SEARCH_EMBEDDINGS=openai), since `auto` picks them only when a valid key exists.
 */
export function checkOpenAiEmbeddingsKey(isOpenAiTarget: boolean, key: string | undefined): void {
  if (!isOpenAiTarget) return;
  if (isPlaceholderKey(key)) {
    throw new Error(
      "Search is set to OpenAI embeddings (SEARCH_EMBEDDINGS=openai) but OPENAI_API_KEY is missing or still the " +
        ".env.example placeholder. Add a real key to scaffold/.env.local, or set SEARCH_EMBEDDINGS=auto to search " +
        "with the built-in model (no key needed).",
    );
  }
}

function httpKey(target: HttpEmbeddingTarget): string {
  const key = process.env.EMBEDDINGS_API_KEY || process.env.OPENAI_API_KEY;
  checkOpenAiEmbeddingsKey(target.isOpenAi, key);
  return key || "local"; // local endpoints (Ollama) ignore the bearer token
}

function embedBody(target: HttpEmbeddingTarget, input: string | string[]): string {
  const { model, dimensions } = target;
  return JSON.stringify(dimensions != null ? { model, dimensions, input } : { model, input });
}

export type EmbedKind = "query" | "document";

export interface EmbedOptions {
  /** Pin a space instead of the active one (a search pins the space of the corpus it loaded). */
  space?: EmbeddingSpace;
  /** Which prefix the space adds: a search query (default for embed) or a program text (default for embedBatch). Per text for a mixed batch. */
  kind?: EmbedKind | EmbedKind[];
}

/** Pure: the texts as the space's model expects them, with its query/document prefixes. */
export function withSpacePrefixes(space: EmbeddingSpace, texts: string[], kind: EmbedKind | EmbedKind[]): string[] {
  return texts.map((t, i) => {
    const k = Array.isArray(kind) ? (kind[i] ?? "document") : kind;
    return `${k === "query" ? space.queryPrefix : space.documentPrefix}${t}`;
  });
}

function meterRecord(meter: CostMeter | undefined, space: EmbeddingSpace, model: string, inputTokens: number, t0: number): void {
  // R4b: built-in and custom embeddings cost nothing and must never be metered as OpenAI.
  meter?.record({
    stage: "query_embedding",
    provider: space.meterProvider,
    model,
    inputTokens,
    outputTokens: 0,
    latencyMs: performance.now() - t0,
  });
}

async function embedHttp(
  space: EmbeddingSpace,
  texts: string[],
  meter: CostMeter | undefined,
  signal: AbortSignal | undefined,
): Promise<number[][]> {
  const target = httpTargetForSpace(space);
  const key = httpKey(target);
  const CHUNK = 128;
  const chunks: string[][] = [];
  for (let i = 0; i < texts.length; i += CHUNK) chunks.push(texts.slice(i, i + CHUNK));

  const perChunk = await Promise.all(
    chunks.map(async (chunk) => {
      const t0 = performance.now();
      const res = await fetch(`${target.baseUrl}/embeddings`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: embedBody(target, chunk.length === 1 && texts.length === 1 ? chunk[0] : chunk),
        signal,
      });
      if (!res.ok) throw new Error(`Embedding request failed (${res.status}): ${await res.text()}`);
      const json = await res.json();
      // R4b — record usage the instant it's available, BEFORE the data access below
      // can throw on a malformed body: an already-spent call's cost must never go unrecorded.
      meterRecord(meter, space, target.model, json?.usage?.prompt_tokens ?? 0, t0);
      const data = (json.data as Array<{ index: number; embedding: number[] }>).slice().sort((a, b) => a.index - b.index);
      return data.map((d) => d.embedding);
    }),
  );
  return perChunk.flat();
}

async function embedInSpace(
  space: EmbeddingSpace,
  texts: string[],
  kind: EmbedKind | EmbedKind[],
  meter: CostMeter | undefined,
  signal: AbortSignal | undefined,
): Promise<number[][]> {
  const inputs = withSpacePrefixes(space, texts, kind);
  if (space.backend === "inprocess") {
    const t0 = performance.now();
    const vectors = await embedWithBuiltin(inputs, { signal });
    meterRecord(meter, space, space.model, 0, t0);
    return vectors;
  }
  return embedHttp(space, inputs, meter, signal);
}

/** Embed one text (a search query unless `opts.kind` says otherwise). */
export async function embed(text: string, meter?: CostMeter, signal?: AbortSignal, opts: EmbedOptions = {}): Promise<number[]> {
  const space = opts.space ?? activeSearchSpace().space;
  const [v] = await embedInSpace(space, [text], opts.kind ?? "query", meter, signal);
  return v;
}

/**
 * Batch embeddings: one request (or one in-process batch run) for many inputs
 * instead of N serial round-trips. Returns one vector per input, in the SAME
 * order as `texts`. Defaults to document embeddings; pass `kind` per text for a
 * mixed batch (lib/competitors/analyze.ts embeds a persona with its records).
 */
export async function embedBatch(
  texts: string[],
  meter?: CostMeter,
  signal?: AbortSignal,
  opts: EmbedOptions = {},
): Promise<number[][]> {
  if (texts.length === 0) return [];
  const space = opts.space ?? activeSearchSpace().space;
  return embedInSpace(space, texts, opts.kind ?? "document", meter, signal);
}

/** Cosine similarity. No vector DB — a few thousand programs is a loop. */
export function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

/**
 * Guard the #1 self-host footgun: a query and a corpus from different models.
 * cosine() iterates over the query vector's length, so mismatched dimensions
 * silently produce NaN or garbage for every program, which looks like a weak
 * field with no hint why. Call once per search, before the retrieval loop.
 * No-op when `corpusDim` is null/0 or the dimensions already match.
 */
export function assertEmbeddingDimsMatch(queryDim: number, corpusDim: number | null | undefined): void {
  if (corpusDim == null || corpusDim === 0) return;
  if (queryDim === corpusDim) return;
  throw new Error(
    `Embedding dimension mismatch: your query embeds to ${queryDim} dims but the corpus is ${corpusDim} dims — these must match for retrieval to work. ` +
      "You likely changed EMBEDDINGS_MODEL without re-embedding the corpus. Re-embed it with the same model: run `npm run data:embed:local` from the scaffold/ directory.",
  );
}

export { getSpace };
