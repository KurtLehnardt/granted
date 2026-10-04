import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Opportunity } from "../types";
import { dropPastAwards } from "./pastAwards";
import { localEmbeddingsActive } from "../embeddings/localEmbeddings";

export interface CorpusMeta {
  builtAt?: string;
  count?: number;
  [key: string]: unknown;
}

/** "local-embeddings": the index Settings → Local built (lib/embeddings), searched only while it's active. */
type CorpusSource = "local-embeddings" | "local" | "committed";

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
}

export interface CorpusStoreOptions {
  /** True while search should use the Settings-built local index (its vectors match local query embeddings). */
  useLocalEmbeddings?: () => boolean;
}

/**
 * Prefers the gitignored `data/local/` refresh over the committed snapshot; reloads on mtime change.
 * While Settings → Local's index is active, serves that instead (same records, local-model vectors).
 */
export class CorpusStore {
  private cache: CorpusCache | null = null;

  constructor(
    private readonly baseDir: string = process.cwd(),
    private readonly options: CorpusStoreOptions = {},
  ) {}

  private paths(source: CorpusSource) {
    const dir =
      source === "local-embeddings"
        ? join(this.baseDir, "data", "local", "local-embeddings")
        : source === "local"
          ? join(this.baseDir, "data", "local")
          : join(this.baseDir, "data");
    return { oppsPath: join(dir, "opportunities.json"), metaPath: join(dir, "corpus-meta.json") };
  }

  load(): CorpusInfo {
    const local = this.paths("local");
    const indexed = this.paths("local-embeddings");
    const useIndexed = Boolean(this.options.useLocalEmbeddings?.()) && existsSync(indexed.oppsPath);
    const key = useIndexed
      ? indexed.oppsPath
      : existsSync(local.oppsPath)
        ? local.oppsPath
        : this.paths("committed").oppsPath;
    const keyMtimeMs = mtimeOf(key);
    const cache = this.cache;
    if (cache && cache.key === key && cache.keyMtimeMs === keyMtimeMs && cache.metaMtimeMs === mtimeOf(cache.metaPath)) {
      return { opportunities: cache.opportunities, meta: cache.meta, source: cache.source };
    }

    let source: CorpusSource = key === indexed.oppsPath ? "local-embeddings" : key === local.oppsPath ? "local" : "committed";
    let opportunities = tryReadOpportunities(key);
    // A corrupt local index must not fall back to OpenAI-dim vectors while queries embed locally — serve nothing instead.
    if (opportunities == null && source === "local") {
      source = "committed";
      opportunities = tryReadOpportunities(this.paths(source).oppsPath);
    }
    opportunities = dropPastAwards(opportunities ?? []);
    const { metaPath } = this.paths(source);
    const meta: CorpusMeta = { ...readJson<CorpusMeta>(metaPath, {}), count: opportunities.length };
    this.cache = { key, keyMtimeMs, metaPath, metaMtimeMs: mtimeOf(metaPath), opportunities, meta, source };
    return { opportunities, meta, source };
  }

  invalidate(): void {
    this.cache = null;
  }
}

const defaultStore = new CorpusStore(process.cwd(), { useLocalEmbeddings: () => localEmbeddingsActive() });

export function getCorpusInfo(): CorpusInfo {
  return defaultStore.load();
}

export function getCorpus(): Opportunity[] {
  return defaultStore.load().opportunities;
}
