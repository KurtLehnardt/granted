import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Opportunity } from "../types";
import { getSpace } from "./spaces";
import { embedWithBuiltin, isBuiltinModelPresent } from "./builtin";
import { buildSpaceVectors, compatibleVectorFile } from "../../scripts/lib/spaceVectors.mjs";
import { readVectorFile, writeVectorFile } from "../../scripts/lib/vectorFile.mjs";
import { BUILTIN_MODEL } from "../../scripts/lib/builtinModel.mjs";

/**
 * Filling in built-in vectors for records that have none.
 *
 * The shipped corpus comes with every built-in vector. A data:refresh copy made
 * before this feature, or while search used OpenAI, has new records with no
 * built-in vector; those score 0 on similarity and are reachable only through
 * keyword matching. When search runs on the built-in model and finds such
 * records, this embeds them in the background and writes
 * data/local/vectors/ (the corpus store picks the file up by its mtime).
 *
 * It runs at low priority: small batches with a pause between them, through
 * the same one-at-a-time queue searches use, so a search waits for at most one
 * small batch. One run per process at a time.
 */

export interface BackfillStatus {
  running: boolean;
  done?: number;
  total?: number;
  error?: string;
}

interface BackfillState {
  run: Promise<void> | null;
  done: number;
  total: number;
  error: string | null;
}

const KEY = Symbol.for("granted.builtinVectorBackfill");
function state(): BackfillState {
  const g = globalThis as unknown as Record<symbol, BackfillState | undefined>;
  return (g[KEY] ??= { run: null, done: 0, total: 0, error: null });
}

/** Test-only. */
export function resetBackfill(): void {
  const g = globalThis as unknown as Record<symbol, BackfillState | undefined>;
  delete g[KEY];
}

export function builtinBackfillStatus(): BackfillStatus {
  const s = state();
  if (s.run) return { running: true, done: s.done, total: s.total };
  return { running: false, ...(s.error ? { error: s.error } : {}) };
}

export interface BackfillDeps {
  baseDir: string;
  modelPresent: () => boolean;
  embed: (texts: string[]) => Promise<number[][]>;
  /** Pause between batches, so searches get the model in between. */
  pauseMs: number;
  batch: number;
}

function realDeps(): BackfillDeps {
  return {
    baseDir: process.cwd(),
    modelPresent: isBuiltinModelPresent,
    embed: (texts) => embedWithBuiltin(texts, { batch: texts.length }),
    pauseMs: 50,
    batch: 8,
  };
}

function readCorpus(baseDir: string): Opportunity[] {
  for (const dir of [join(baseDir, "data", "local"), join(baseDir, "data")]) {
    const path = join(dir, "opportunities.json");
    if (!existsSync(path)) continue;
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8"));
      if (Array.isArray(parsed)) return parsed;
    } catch {
      /* try the next one */
    }
  }
  return [];
}

/**
 * Start filling in missing built-in vectors, unless a run is already going or the
 * model isn't downloaded. Returns whether a run was started. Never throws; a
 * failure is kept for the status line and the next call tries again.
 */
export function startBuiltinVectorBackfill(deps: Partial<BackfillDeps> = {}): boolean {
  const d = { ...realDeps(), ...deps };
  const s = state();
  if (s.run || !d.modelPresent()) return false;
  const space = getSpace("builtin");
  const name = space.vectors.kind === "file" ? space.vectors.name : "";
  const localDir = join(d.baseDir, "data", "local", "vectors");
  const committedDir = join(d.baseDir, "data", "vectors");
  s.error = null;
  s.done = 0;
  s.total = 0;
  s.run = (async () => {
    const opps = readCorpus(d.baseDir);
    type Prior = Map<string, { vector: number[]; textHash?: string }>;
    const prior: Prior = new Map();
    for (const f of [readVectorFile(committedDir, name), readVectorFile(localDir, name)]) {
      if (f && compatibleVectorFile(f, space)) (f.vectors as Prior).forEach((v, id) => prior.set(id, v));
    }
    const result = await buildSpaceVectors(space, opps, {
      prior,
      batch: d.batch,
      embed: async (texts) => {
        await new Promise((r) => setTimeout(r, d.pauseMs));
        return d.embed(texts);
      },
      onProgress: (done, total) => {
        s.done = done;
        s.total = total;
      },
    });
    if (result.embedded > 0) {
      writeVectorFile(localDir, name, { space: space.id, model: space.model, revision: BUILTIN_MODEL.revision, dims: space.dims as number }, result.entries);
    }
  })()
    .catch((e) => {
      s.error = `couldn't index the remaining grants (${(e as Error)?.message ?? e})`;
    })
    .finally(() => {
      s.run = null;
    });
  return true;
}

/** Wait for the current run, if any (tests and scripts). */
export async function backfillSettled(): Promise<void> {
  await state().run;
}
