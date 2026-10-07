import {
  BUILTIN_MODEL,
  BUILTIN_MODEL_TOTAL_BYTES,
  builtinModelPresent,
  downloadBuiltinModel,
  loadBuiltinEmbedder,
  modelBaseUrl,
  modelsDir,
} from "../../scripts/lib/builtinModel.mjs";
import { logError } from "../errorLog/server";

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
  /** Why the model files are there but the model wouldn't load (e.g. the VC++ runtime is missing). */
  lastLoadError: string | null;
  queue: Promise<unknown>;
  listeners: Set<(pct: number) => void>;
}

const KEY = Symbol.for("granted.builtinSearchModel");
function state(): RuntimeState {
  const g = globalThis as unknown as Record<symbol, RuntimeState | undefined>;
  return (g[KEY] ??= { embedder: null, download: null, progress: null, lastError: null, lastLoadError: null, queue: Promise.resolve(), listeners: new Set() });
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
  if (d.present(d.dir)) return s.lastLoadError ? { ...base, state: "failed", error: s.lastLoadError } : { ...base, state: "ready" };
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
          s.lastError = `couldn't download the search model (${(e as Error)?.message ?? e})`;
          logError("builtin-model", e);
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
  state().lastLoadError = null; // a Retry also retries loading
  ensureBuiltinModel(undefined, deps).catch(() => {
    /* recorded in the status as "failed" */
  });
}

async function getEmbedder(d: BuiltinDeps): Promise<Embedder> {
  const s = state();
  if (!s.embedder) {
    s.embedder = (async () => {
      await ensureBuiltinModel(undefined, d);
      try {
        const embedder = await d.load(d.dir);
        s.lastLoadError = null;
        return embedder;
      } catch (err) {
        s.lastLoadError = explainModelLoadError(err);
        logError("builtin-model", err);
        throw new Error(s.lastLoadError);
      }
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

/**
 * A plain-language reason the model wouldn't load. On Windows the usual cause is
 * a missing Microsoft Visual C++ runtime: onnxruntime's DLL needs msvcp140.dll,
 * msvcp140_1.dll, vcruntime140.dll and vcruntime140_1.dll, which a clean Windows
 * install lacks (the Windows installer adds them), and Node reports only "The
 * specified module could not be found".
 */
export function explainModelLoadError(err: unknown, platform: NodeJS.Platform = process.platform): string {
  const detail = String((err as Error)?.message ?? err ?? "").replace(/\s+/g, " ").trim();
  if (platform === "win32" && /specified module could not be found|onnxruntime|\.node\b|\.dll\b|dlopen/i.test(detail)) {
    return (
      "the search model couldn't start because the Microsoft Visual C++ runtime is missing on this computer. " +
      "Install it from https://aka.ms/vs/17/release/vc_redist.x64.exe (or run the Granted installer again), then restart Granted"
    );
  }
  return `the search model couldn't start (${detail.length > 200 ? `${detail.slice(0, 197)}...` : detail})`;
}

export function isBuiltinModelPresent(): boolean {
  return builtinModelPresent(modelsDir());
}
