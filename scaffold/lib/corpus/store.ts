import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Opportunity } from "../types";
import { dropPastAwards } from "./pastAwards";

export interface CorpusMeta {
  builtAt?: string;
  count?: number;
  [key: string]: unknown;
}

type CorpusSource = "local" | "committed";

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

/** Prefers the gitignored `data/local/` refresh over the committed snapshot; reloads on mtime change. */
export class CorpusStore {
  private cache: CorpusCache | null = null;

  constructor(private readonly baseDir: string = process.cwd()) {}

  private paths(source: CorpusSource) {
    const dir = source === "local" ? join(this.baseDir, "data", "local") : join(this.baseDir, "data");
    return { oppsPath: join(dir, "opportunities.json"), metaPath: join(dir, "corpus-meta.json") };
  }

  load(): CorpusInfo {
    const local = this.paths("local");
    const key = existsSync(local.oppsPath) ? local.oppsPath : this.paths("committed").oppsPath;
    const keyMtimeMs = mtimeOf(key);
    const cache = this.cache;
    if (cache && cache.key === key && cache.keyMtimeMs === keyMtimeMs && cache.metaMtimeMs === mtimeOf(cache.metaPath)) {
      return { opportunities: cache.opportunities, meta: cache.meta, source: cache.source };
    }

    let source: CorpusSource = key === local.oppsPath ? "local" : "committed";
    let opportunities = tryReadOpportunities(key);
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

const defaultStore = new CorpusStore();

export function getCorpusInfo(): CorpusInfo {
  return defaultStore.load();
}

export function getCorpus(): Opportunity[] {
  return defaultStore.load().opportunities;
}
