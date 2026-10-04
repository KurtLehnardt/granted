import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Opportunity } from "../types";
import { dropPastAwards } from "./pastAwards";
import { localEmbeddingsActive, localEmbeddingsBaseDir, localEmbeddingsPaths } from "../embeddings/localEmbeddings";

export interface CorpusMeta {
  builtAt?: string;
  count?: number;
  [key: string]: unknown;
}

/** "local-embeddings": the index Settings → Local built (lib/embeddings), searched only while it's active. */
export type CorpusSource = "local-embeddings" | "local" | "committed";

export interface CorpusInfo {
  opportunities: Opportunity[];
  meta: CorpusMeta;
  source: CorpusSource;
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

interface CorpusCache extends CorpusInfo {
  key: string;
  keyMtimeMs: number;
  metaPath: string;
  metaMtimeMs: number;
  /** The hosted meta path this load resolved (before any corrupt-file fallback). */
  hostedMetaPath: string;
}

export interface CorpusStoreOptions {
  /**
   * The Settings → Local index directory to search, or null when it isn't active.
   * Must come from the same readiness decision the query embedding follows
   * (lib/embeddings/localEmbeddings.ts's localEmbeddingsActive); the caller then
   * embeds the query for `CorpusInfo.source`, so the two can never disagree.
   */
  localIndexDir?: () => string | null;
}

/**
 * Prefers the gitignored `data/local/` refresh over the committed snapshot; reloads on mtime change.
 * While Settings → Local's index is active, serves its records instead (local-model vectors), but
 * freshness (`meta.builtAt`) still comes from that hosted corpus: the index is derived from it, and a
 * data:refresh must not look stale just because the index hasn't been re-embedded yet.
 */
export class CorpusStore {
  private cache: CorpusCache | null = null;

  constructor(
    private readonly baseDir: string = process.cwd(),
    private readonly options: CorpusStoreOptions = {},
  ) {}

  private paths(source: Exclude<CorpusSource, "local-embeddings">) {
    const dir = source === "local" ? join(this.baseDir, "data", "local") : join(this.baseDir, "data");
    return { oppsPath: join(dir, "opportunities.json"), metaPath: join(dir, "corpus-meta.json") };
  }

  load(): CorpusInfo {
    const local = this.paths("local");
    const hostedSource: CorpusSource = existsSync(local.oppsPath) ? "local" : "committed";
    const hosted = this.paths(hostedSource);
    const indexDir = this.options.localIndexDir?.() ?? null;
    const key = indexDir ? join(indexDir, "opportunities.json") : hosted.oppsPath;
    const keyMtimeMs = mtimeOf(key);
    const cache = this.cache;
    if (
      cache &&
      cache.key === key &&
      cache.keyMtimeMs === keyMtimeMs &&
      // The meta (freshness) file can move on its own: a first data:refresh while the index is served.
      cache.hostedMetaPath === hosted.metaPath &&
      cache.metaMtimeMs === mtimeOf(cache.metaPath)
    ) {
      return { opportunities: cache.opportunities, meta: cache.meta, source: cache.source };
    }

    let source: CorpusSource = indexDir ? "local-embeddings" : hostedSource;
    let opportunities = tryReadOpportunities(key);
    // A corrupt local index must not fall back to OpenAI-dim vectors while queries embed locally: serve nothing instead.
    if (opportunities == null && source === "local") {
      source = "committed";
      opportunities = tryReadOpportunities(this.paths(source).oppsPath);
    }
    opportunities = dropPastAwards(opportunities ?? []);
    // Freshness always comes from the hosted corpus the records were derived from.
    const metaSource = source === "local-embeddings" ? hostedSource : source;
    const { metaPath } = this.paths(metaSource);
    const meta: CorpusMeta = { ...readJson<CorpusMeta>(metaPath, {}), count: opportunities.length };
    this.cache = { key, keyMtimeMs, metaPath, metaMtimeMs: mtimeOf(metaPath), hostedMetaPath: hosted.metaPath, opportunities, meta, source };
    return { opportunities, meta, source };
  }

  invalidate(): void {
    this.cache = null;
  }
}

const defaultStore = new CorpusStore(process.cwd(), {
  localIndexDir: () => {
    const base = localEmbeddingsBaseDir();
    return localEmbeddingsActive(base) ? localEmbeddingsPaths(base).dir : null;
  },
});

export function getCorpusInfo(): CorpusInfo {
  return defaultStore.load();
}

export function getCorpus(): Opportunity[] {
  return defaultStore.load().opportunities;
}
