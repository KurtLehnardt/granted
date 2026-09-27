import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Opportunity } from "../types";

/**
 * Runtime corpus loader (local-LLM-first: each install refreshes its own
 * data, never a build-time bundle). Prefers the gitignored local refresh
 * (`data/local/opportunities.json` + `corpus-meta.json`, written by
 * `npm run data:refresh`) and falls back to the committed snapshot
 * (`data/opportunities.json` + `data/corpus-meta.json`). Cached in memory and
 * keyed by the resolved file's mtime, so a refresh takes effect in a running
 * `next dev`/`next start` process without a restart.
 */
export interface CorpusMeta {
  builtAt?: string;
  note?: string;
  count?: number;
  embeddingModel?: string;
  dims?: number;
  [key: string]: unknown;
}

export interface CorpusInfo {
  opportunities: Opportunity[];
  meta: CorpusMeta;
  source: "local" | "committed";
}

function readJson<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}

/** Distinguishes "file missing/corrupt" (null) from "parsed, but empty" ([]) —
 *  the caller needs that distinction to fall back to the committed corpus
 *  instead of silently serving an empty one. */
function tryReadOpportunities(path: string): Opportunity[] | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function mtimeOf(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

export class CorpusStore {
  private readonly baseDir: string;
  private cache: { path: string; mtimeMs: number; opportunities: Opportunity[]; meta: CorpusMeta } | null = null;

  constructor(baseDir: string = process.cwd()) {
    this.baseDir = baseDir;
  }

  private resolvePaths(): { oppsPath: string; metaPath: string; source: "local" | "committed" } {
    const localOpps = join(this.baseDir, "data", "local", "opportunities.json");
    if (existsSync(localOpps)) {
      return { oppsPath: localOpps, metaPath: join(this.baseDir, "data", "local", "corpus-meta.json"), source: "local" };
    }
    return {
      oppsPath: join(this.baseDir, "data", "opportunities.json"),
      metaPath: join(this.baseDir, "data", "corpus-meta.json"),
      source: "committed",
    };
  }

  load(): CorpusInfo {
    let { oppsPath, metaPath, source } = this.resolvePaths();
    let mtimeMs = mtimeOf(oppsPath);
    if (this.cache && this.cache.path === oppsPath && this.cache.mtimeMs === mtimeMs) {
      return { opportunities: this.cache.opportunities, meta: this.cache.meta, source };
    }
    let opportunities = tryReadOpportunities(oppsPath);
    if (opportunities == null && source === "local") {
      // Corrupt/unreadable local refresh — fall back to the committed
      // snapshot rather than silently serving an empty corpus.
      oppsPath = join(this.baseDir, "data", "opportunities.json");
      metaPath = join(this.baseDir, "data", "corpus-meta.json");
      source = "committed";
      mtimeMs = mtimeOf(oppsPath);
      opportunities = tryReadOpportunities(oppsPath) ?? [];
    } else if (opportunities == null) {
      opportunities = [];
    }
    const rawMeta = readJson<CorpusMeta>(metaPath, {});
    const dims = opportunities.find((o) => Array.isArray(o.embedding) && o.embedding.length > 0)?.embedding?.length;
    const meta: CorpusMeta = { ...rawMeta, count: opportunities.length, dims: rawMeta.dims ?? dims };
    this.cache = { path: oppsPath, mtimeMs, opportunities, meta };
    return { opportunities, meta, source };
  }

  /** Test-only: force the next `load()` to re-read from disk. */
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

export function getCorpusMeta(): CorpusMeta {
  return defaultStore.load().meta;
}
