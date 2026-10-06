import {
  BUILTIN_MODEL,
  BUILTIN_MODEL_TOTAL_BYTES,
  builtinModelPresent,
  downloadBuiltinModel,
  loadBuiltinEmbedder,
  modelBaseUrl,
  modelsDir,
} from "../../scripts/lib/builtinModel.mjs";

/**
 * The built-in search model at runtime (the in-process backend of the
 * "builtin" embedding space, see ./spaces.ts).
 *
 * - One embedder per server process, loaded lazily on the first search and kept
 *   (loading takes a couple of seconds; embedding a query then takes tens of ms).
 * - Model files come only from scaffold/models/ (remote loading is off), so
 *   search works offline. The installers download them; when they're missing
 *   anyway (a failed download during install, a manual clone), the first search
 *   downloads them here, once, and Settings → Model shows the progress.
 * - Embedding calls run one batch at a time: the model already uses every core,
 *   and overlapping runs would only slow each other down.
 *
 * State lives on globalThis so every route bundle in the Next.js server shares
 * one embedder and one download.
 */

export type BuiltinModelState = "ready" | "missing" | "downloading" | "failed";

export interface BuiltinModelStatus {
  state: BuiltinModelState;
  model: string;
  /** Download progress while downloading. */
  pct?: number;
  doneBytes?: number;
  totalBytes: number;
  error?: string;
  /** Set when GRANTED_MODEL_URL points the download at a mirror. */
  mirror?: string;
}

type Embedder = { embed: (texts: string[]) => Promise<number[][]>; dims: number };

interface RuntimeState {
  embedder: Promise<Embedder> | null;
  download: Promise<void> | null;
  progress: { pct: number; doneBytes: number } | null;
  lastError: string | null;
  queue: Promise<unknown>;
  listeners: Set<(pct: number) => void>;
}

const KEY = Symbol.for("granted.builtinSearchModel");
function state(): RuntimeState {
  const g = globalThis as unknown as Record<symbol, RuntimeState | undefined>;
  return (g[KEY] ??= { embedder: null, download: null, progress: null, lastError: null, queue: Promise.resolve(), listeners: new Set() });
}

/** Test-only: forget the loaded embedder and any download state. */
export function resetBuiltinRuntime(): void {
  const g = globalThis as unknown as Record<symbol, RuntimeState | undefined>;
  delete g[KEY];
}

export interface BuiltinDeps {
  dir: string;
  present: (dir: string) => boolean;
  download: typeof downloadBuiltinModel;
  load: (dir: string) => Promise<Embedder>;
  /** Whether a missing model may be downloaded now. Off under node:test unless a test injects its own download. */
  allowDownload: boolean;
}

function realDeps(): BuiltinDeps {
  return {
    dir: modelsDir(),
    present: (dir) => builtinModelPresent(dir),
    download: downloadBuiltinModel,
    load: (dir) => loadBuiltinEmbedder({ dir }),
    allowDownload: !process.env.NODE_TEST_CONTEXT,
  };
}

export function builtinModelStatus(deps: Partial<BuiltinDeps> = {}): BuiltinModelStatus {
  const d = { ...realDeps(), ...deps };
  const s = state();
  const mirror = process.env.GRANTED_MODEL_URL?.trim() ? modelBaseUrl() : undefined;
  const base = { model: BUILTIN_MODEL.repo.split("/")[1], totalBytes: BUILTIN_MODEL_TOTAL_BYTES, ...(mirror ? { mirror } : {}) };
  if (s.download) return { ...base, state: "downloading", pct: s.progress?.pct ?? 0, doneBytes: s.progress?.doneBytes ?? 0 };
  if (d.present(d.dir)) return { ...base, state: "ready" };
  if (s.lastError) return { ...base, state: "failed", error: s.lastError };
  return { ...base, state: "missing" };
}

/**
 * Make sure the model files are on disk, downloading them if needed. Concurrent
 * callers share one download; `onProgress(pct)` hears its progress.
 */
export async function ensureBuiltinModel(onProgress?: (pct: number) => void, deps: Partial<BuiltinDeps> = {}): Promise<void> {
  const d = { ...realDeps(), ...deps };
  if (d.present(d.dir)) return;
  const s = state();
  if (!s.download) {
    if (!d.allowDownload) {
      throw new Error("The built-in search model isn't downloaded yet. Run `npm run model:fetch` in scaffold/.");
    }
    s.lastError = null;
    s.progress = { pct: 0, doneBytes: 0 };
    s.download = d
      .download({
        dir: d.dir,
        onProgress: ({ pct, doneBytes }: { pct: number; doneBytes: number }) => {
          s.progress = { pct, doneBytes };
          s.listeners.forEach((l) => {
            try {
              l(pct);
            } catch {
              /* a progress listener must never break the download */
            }
          });
        },
      })
      .then(
        () => {
          s.download = null;
          s.progress = null;
        },
        (e: unknown) => {
          s.download = null;
          s.progress = null;
          s.lastError = `Couldn't download the search model: ${(e as Error)?.message ?? e}`;
          throw new Error(s.lastError);
        },
      );
  }
  const download = s.download;
  if (onProgress) s.listeners.add(onProgress);
  try {
    await download;
  } finally {
    if (onProgress) s.listeners.delete(onProgress);
  }
}

/** Start the download without waiting for it (Settings → "Download now"). Never throws. */
export function startBuiltinModelDownload(deps: Partial<BuiltinDeps> = {}): void {
  ensureBuiltinModel(undefined, deps).catch(() => {
    /* recorded in the status as "failed" */
  });
}

async function getEmbedder(d: BuiltinDeps): Promise<Embedder> {
  const s = state();
  if (!s.embedder) {
    s.embedder = (async () => {
      await ensureBuiltinModel(undefined, d);
      return d.load(d.dir);
    })();
    // A failed load must not stick: the next search tries again.
    s.embedder.catch(() => {
      if (state().embedder === s.embedder) state().embedder = null;
    });
  }
  return s.embedder;
}

/**
 * Embed `texts` with the built-in model (callers add the space's prefixes).
 * Batches of `batch`, one at a time across the whole process.
 */
export async function embedWithBuiltin(
  texts: string[],
  opts: { batch?: number; signal?: AbortSignal } = {},
  deps: Partial<BuiltinDeps> = {},
): Promise<number[][]> {
  if (texts.length === 0) return [];
  const d = { ...realDeps(), ...deps };
  const embedder = await getEmbedder(d);
  const batch = opts.batch ?? 16;
  const s = state();
  const run = s.queue.then(async () => {
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += batch) {
      if (opts.signal?.aborted) throw opts.signal.reason ?? new Error("aborted");
      out.push(...(await embedder.embed(texts.slice(i, i + batch))));
    }
    return out;
  });
  s.queue = run.catch(() => undefined);
  return run;
}

export function isBuiltinModelPresent(): boolean {
  return builtinModelPresent(modelsDir());
}
