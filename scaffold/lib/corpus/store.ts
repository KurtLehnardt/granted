import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Opportunity } from "../types";
import { dropPastAwards } from "./pastAwards";
import { activeSearchSpace, type EmbeddingSpace } from "../embeddings/spaces";
import { removeLegacyLocalEmbeddingsOnce } from "../embeddings/legacyCleanup";
import { readVectorFile, textHash, vectorFilePaths } from "../../scripts/lib/vectorFile.mjs";
import { compatibleVectorFile, spaceDocumentText } from "../../scripts/lib/spaceVectors.mjs";

export interface CorpusMeta {
  builtAt?: string;
  count?: number;
  [key: string]: unknown;
}

/** "local": the gitignored data:refresh copy in data/local/; "committed": the shipped snapshot. */
export type CorpusSource = "local" | "committed";

export interface CorpusInfo {
  opportunities: Opportunity[];
  meta: CorpusMeta;
  source: CorpusSource;
  /** The embedding space the records' `embedding` vectors belong to; a search embeds its query in this space. */
  space: EmbeddingSpace;
  /** How many records have a vector in that space (the rest are reachable only by keyword search). */
  withVectors: number;
  /** Set when the store had to pass over the data:refresh copy, and why (shown on Settings' Search line). */
  note?: string;
}

function readJson<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}

function tryReadOpportunities(path: string): Opportunity[] | null {
  const parsed = readJson<unknown>(path, null);
  return Array.isArray(parsed) ? parsed : null;
}

function mtimeOf(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

type VectorMap = Map<string, { vector: number[]; textHash?: string }>;

/**
 * Pure: give each record its vector in a vector-file space. A vector is used only
 * when its text hash matches the record's current text (an edited record must not
 * keep a stale vector). `sources` are tried in order, so a data:refresh's own
 * vectors win and the committed ones fill in for unchanged records. Records with
 * no usable vector get no `embedding` and stay reachable through keyword search.
 */
export function attachSpaceVectors(
  space: EmbeddingSpace,
  opportunities: Opportunity[],
  sources: Array<VectorMap | null | undefined>,
): { opportunities: Opportunity[]; withVectors: number } {
  let withVectors = 0;
  const out = opportunities.map((o) => {
    const hash = textHash(spaceDocumentText(space, o));
    for (const src of sources) {
      const hit = src?.get(o.id);
      if (hit && hit.textHash === hash && (space.dims == null || hit.vector.length === space.dims)) {
        withVectors++;
        return { ...o, embedding: hit.vector };
      }
    }
    const { embedding: _drop, ...rest } = o;
    return rest as Opportunity;
  });
  return { opportunities: out, withVectors };
}

/** Length of the first inline vector, or null when no record has one. */
function inlineDims(opportunities: Opportunity[]): number | null {
  const v = opportunities.find((o) => Array.isArray(o.embedding) && o.embedding.length > 0)?.embedding;
  return v ? v.length : null;
}

interface CorpusCache extends CorpusInfo {
  key: string;
}

export interface CorpusStoreOptions {
  /** The space to serve vectors for; defaults to the active search space. */
  space?: () => EmbeddingSpace;
}

/**
 * Prefers the gitignored `data/local/` refresh over the committed snapshot and
 * reloads when any file it read changes. Vectors come from the space search is
 * using: inline in opportunities.json for OpenAI (and a custom embedder), or the
 * space's own vector file (data/vectors/, data/local/vectors/) for the built-in model.
 */
export class CorpusStore {
  private cache: CorpusCache | null = null;

  constructor(
    private readonly baseDir: string = process.cwd(),
    private readonly options: CorpusStoreOptions = {},
  ) {}

  private paths(source: CorpusSource) {
    const dir = source === "local" ? join(this.baseDir, "data", "local") : join(this.baseDir, "data");
    return { dir, oppsPath: join(dir, "opportunities.json"), metaPath: join(dir, "corpus-meta.json"), vectorsDir: join(dir, "vectors") };
  }

  load(): CorpusInfo {
    const space = (this.options.space ?? (() => activeSearchSpace().space))();
    const local = this.paths("local");
    const committed = this.paths("committed");
    const hostedSource: CorpusSource = existsSync(local.oppsPath) ? "local" : "committed";
    const hosted = this.paths(hostedSource);

    const watched = [hosted.oppsPath, hosted.metaPath];
    if (space.vectors.kind === "file") {
      for (const dir of [local.vectorsDir, committed.vectorsDir]) {
        const { binPath, metaPath } = vectorFilePaths(dir, space.vectors.name);
        watched.push(binPath, metaPath);
      }
    }
    const key = `${space.id}|${watched.map((p) => `${p}@${mtimeOf(p)}`).join("|")}`;
    if (this.cache && this.cache.key === key) {
      const { key: _k, ...info } = this.cache;
      return info;
    }

    let source: CorpusSource = hostedSource;
    let note: string | undefined;
    let opportunities = tryReadOpportunities(hosted.oppsPath);
    if (opportunities == null && source === "local") {
      source = "committed";
      opportunities = tryReadOpportunities(committed.oppsPath);
    }
    // An inline space with a fixed size (OpenAI: 512) can't search a data:refresh copy whose
    // inline vectors are another size (e.g. 768-dim nomic vectors written by an older
    // `setup:local` re-embed): serve the shipped snapshot instead of failing every search.
    if (source === "local" && space.vectors.kind === "inline" && space.dims != null) {
      const localDims = inlineDims(opportunities ?? []);
      if (localDims != null && localDims !== space.dims) {
        source = "committed";
        opportunities = tryReadOpportunities(committed.oppsPath);
        note =
          `Your refreshed grant list was embedded with another model (${localDims}-dimension vectors), so search is using the shipped list. ` +
          "Run Refresh cached grants to rebuild it for the current search.";
      }
    }
    opportunities = dropPastAwards(opportunities ?? []);

    let withVectors: number;
    if (space.vectors.kind === "file") {
      const name = space.vectors.name;
      // A refresh's own vectors win; the committed ones cover every unchanged record. Either
      // file is used only if it was made by this space's model (and, when pinned, revision).
      const sources = [readVectorFile(local.vectorsDir, name), readVectorFile(committed.vectorsDir, name)].filter((f) => compatibleVectorFile(f, space));
      ({ opportunities, withVectors } = attachSpaceVectors(space, opportunities, sources.map((s) => s?.vectors as VectorMap | undefined)));
    } else {
      withVectors = opportunities.filter((o) => Array.isArray(o.embedding) && o.embedding.length > 0).length;
    }

    const { metaPath } = this.paths(source);
    const meta: CorpusMeta = { ...readJson<CorpusMeta>(metaPath, {}), count: opportunities.length };
    const info: CorpusInfo = { opportunities, meta, source, space, withVectors, ...(note ? { note } : {}) };
    this.cache = { ...info, key };
    return info;
  }

  invalidate(): void {
    this.cache = null;
  }
}

const defaultStore = new CorpusStore(process.cwd());

export function getCorpusInfo(): CorpusInfo {
  removeLegacyLocalEmbeddingsOnce();
  return defaultStore.load();
}

export function getCorpus(): Opportunity[] {
  return defaultStore.load().opportunities;
}
