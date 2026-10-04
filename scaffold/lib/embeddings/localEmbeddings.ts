import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { normalizeOpenAiBaseUrl } from "../llm/baseUrl";
import { resolveProvider } from "../llm/config";
import { isProcessAlive } from "../corpus/refreshStatus";

/**
 * Settings-driven local embeddings.
 *
 * Picking "Local (Ollama)" in Settings moves scoring/explanations to Ollama, but
 * search retrieval also needs the query AND the corpus embedded by the same
 * local model (the committed corpus is OpenAI 512-dim; nomic-embed-text is
 * 768-dim). So, when embeddings aren't already configured in .env.local, the app
 * prepares a separate local search index in the background (pull the embedding
 * model if needed, then re-embed the corpus — see ./localEmbedJob.ts) and only
 * switches retrieval to it once it's complete:
 *
 *   data/local/local-embeddings/opportunities.json   the re-embedded corpus
 *   data/local/local-embeddings/corpus-meta.json      written LAST; `complete: true` = ready
 *   data/local/local-embeddings-job.json              progress / last error of the background job
 *   data/local/local-embeddings.lock                  single-flight lock (owner pid)
 *
 * The hosted corpus (data/local/opportunities.json or the committed snapshot) is
 * never touched, so switching back to a cloud model restores hosted embeddings
 * with no rebuild, and switching to Local again reuses the finished index.
 */

export const LOCAL_EMBED_MODEL = "nomic-embed-text";

/** Where the data/local/ files above live. Tests isolate via GRANTED_LOCAL_EMBEDDINGS_BASE_DIR; under node:test with no override, a never-existing dir (a developer's real index must not leak into tests). */
export function localEmbeddingsBaseDir(): string {
  if (process.env.GRANTED_LOCAL_EMBEDDINGS_BASE_DIR) return process.env.GRANTED_LOCAL_EMBEDDINGS_BASE_DIR;
  if (process.env.NODE_TEST_CONTEXT) return join(os.tmpdir(), `granted-local-embeddings-unset-${process.pid}`);
  return process.cwd();
}

export function localEmbeddingsPaths(baseDir: string = localEmbeddingsBaseDir()) {
  const localDir = join(baseDir, "data", "local");
  const dir = join(localDir, "local-embeddings");
  return {
    localDir,
    dir,
    oppsPath: join(dir, "opportunities.json"),
    metaPath: join(dir, "corpus-meta.json"),
    jobPath: join(localDir, "local-embeddings-job.json"),
    lockPath: join(localDir, "local-embeddings.lock"),
  };
}

/** The corpus a re-embed reads — the one the hosted path serves: a data:refresh copy if present, else the committed snapshot. */
export function sourceCorpusPaths(baseDir: string = localEmbeddingsBaseDir()) {
  const local = join(baseDir, "data", "local");
  const dir = existsSync(join(local, "opportunities.json")) ? local : join(baseDir, "data");
  return { dir, oppsPath: join(dir, "opportunities.json"), metaPath: join(dir, "corpus-meta.json") };
}

/** Ollama's OpenAI-compatible base (for /embeddings) and its native root (for /api/tags, /api/pull) — the same server the local chat model uses. */
export function localOllamaUrls(llmBaseUrl: string | undefined = process.env.LLM_BASE_URL) {
  const openAiBaseUrl = normalizeOpenAiBaseUrl(llmBaseUrl || "http://localhost:11434/v1");
  const nativeBaseUrl = openAiBaseUrl.replace(/\/v1$/i, "");
  return { openAiBaseUrl, nativeBaseUrl };
}

/** True when .env.local doesn't point EMBEDDINGS_BASE_URL anywhere but OpenAI — i.e. the app, not the user, decides where embeddings run. */
export function envEmbeddingsAreHosted(embeddingsBaseUrl: string | undefined = process.env.EMBEDDINGS_BASE_URL): boolean {
  return /api\.openai\.com/.test(normalizeOpenAiBaseUrl(embeddingsBaseUrl || "https://api.openai.com/v1"));
}

// ---------------------------------------------------------------------------
// Index metadata (written last by the job) and readiness
// ---------------------------------------------------------------------------

export interface LocalIndexMeta {
  complete?: boolean;
  embeddingModel?: string;
  dims?: number;
  count?: number;
  builtAt?: string;
  sourceBuiltAt?: string | null;
  sourceCount?: number;
  embeddedAt?: string;
  [key: string]: unknown;
}

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
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

const metaCache = new Map<string, { mtimeMs: number; meta: LocalIndexMeta | null }>();

/** The local index's meta, mtime-cached (this runs on every search and corpus load). Null when absent/corrupt. */
export function readLocalIndexMeta(baseDir: string = localEmbeddingsBaseDir()): LocalIndexMeta | null {
  const { metaPath } = localEmbeddingsPaths(baseDir);
  const mtimeMs = mtimeOf(metaPath);
  if (!mtimeMs) {
    metaCache.delete(metaPath);
    return null;
  }
  const cached = metaCache.get(metaPath);
  if (cached && cached.mtimeMs === mtimeMs) return cached.meta;
  const meta = readJson<LocalIndexMeta>(metaPath);
  metaCache.set(metaPath, { mtimeMs, meta });
  return meta;
}

/** Pure: a finished index embedded with `model`. Partial runs never write meta, so a crash mid-embed is never "ready". */
export function isLocalIndexReady(meta: LocalIndexMeta | null | undefined, model: string = LOCAL_EMBED_MODEL): boolean {
  return Boolean(
    meta &&
      meta.complete === true &&
      meta.embeddingModel === model &&
      typeof meta.dims === "number" &&
      meta.dims > 0 &&
      typeof meta.count === "number" &&
      meta.count > 0,
  );
}

/** Pure: the hosted corpus changed (data:refresh, or a newer committed snapshot) since the index was built. */
export function isLocalIndexOutdated(
  meta: LocalIndexMeta | null | undefined,
  sourceMeta: { builtAt?: unknown; count?: unknown } | null | undefined,
): boolean {
  if (!meta || !sourceMeta) return false;
  const builtAt = typeof sourceMeta.builtAt === "string" ? sourceMeta.builtAt : null;
  if ((meta.sourceBuiltAt ?? null) !== builtAt) return true;
  return typeof sourceMeta.count === "number" && typeof meta.sourceCount === "number" && sourceMeta.count !== meta.sourceCount;
}

/**
 * Pure: should search use the local index right now? Only when the user picked
 * Local in Settings, didn't configure embeddings themselves in .env.local, and
 * the index is complete. Anything else keeps today's embeddings untouched.
 */
export function shouldUseLocalIndex(input: { provider: "ollama" | "cloud"; envIsHosted: boolean; ready: boolean }): boolean {
  return input.provider === "ollama" && input.envIsHosted && input.ready;
}

/** Live check used by lib/embed.ts (query embeddings) and lib/corpus/store.ts (which corpus to search). */
export function localEmbeddingsActive(baseDir: string = localEmbeddingsBaseDir()): boolean {
  return shouldUseLocalIndex({
    provider: resolveProvider(),
    envIsHosted: envEmbeddingsAreHosted(),
    ready: isLocalIndexReady(readLocalIndexMeta(baseDir)),
  });
}

// ---------------------------------------------------------------------------
// Background job: progress/error file + single-flight lock
// ---------------------------------------------------------------------------

export type LocalEmbeddingsStage = "checking" | "pulling" | "embedding" | "saving";
export type LocalEmbeddingsErrorKind = "ollama-unreachable" | "pull-failed" | "embed-failed" | "unknown";

export interface LocalEmbeddingsJob {
  stage?: LocalEmbeddingsStage;
  done?: number;
  total?: number;
  pct?: number;
  startedAt?: string;
  finishedAt?: string;
  lastError?: string;
  errorKind?: LocalEmbeddingsErrorKind;
  lastFailedAt?: string;
}

export function readLocalEmbeddingsJob(baseDir: string = localEmbeddingsBaseDir()): LocalEmbeddingsJob {
  return readJson<LocalEmbeddingsJob>(localEmbeddingsPaths(baseDir).jobPath) ?? {};
}

export function writeLocalEmbeddingsJob(job: LocalEmbeddingsJob, baseDir: string = localEmbeddingsBaseDir()): void {
  const { localDir, jobPath } = localEmbeddingsPaths(baseDir);
  mkdirSync(localDir, { recursive: true });
  const body = JSON.stringify(job, null, 2);
  const tmp = `${jobPath}.tmp-${process.pid}`;
  writeFileSync(tmp, body);
  try {
    renameSync(tmp, jobPath);
  } catch {
    // Windows refuses to rename over a file a reader has open (same fallback as refreshStatus).
    rmSync(tmp, { force: true });
    writeFileSync(jobPath, body);
  }
}

export function isLocalEmbeddingsRunning(baseDir: string = localEmbeddingsBaseDir()): boolean {
  const { lockPath } = localEmbeddingsPaths(baseDir);
  if (!existsSync(lockPath)) return false;
  const info = readJson<{ pid?: number }>(lockPath);
  if (typeof info?.pid === "number" && isProcessAlive(info.pid)) return true;
  try {
    unlinkSync(lockPath); // stale: its owner died (hard kill, reboot)
  } catch {
    /* already gone */
  }
  return false;
}

export function acquireLocalEmbeddingsLock(baseDir: string = localEmbeddingsBaseDir(), pid: number = process.pid): boolean {
  const { localDir, lockPath } = localEmbeddingsPaths(baseDir);
  mkdirSync(localDir, { recursive: true });
  const body = JSON.stringify({ pid, startedAt: Date.now() });
  try {
    writeFileSync(lockPath, body, { flag: "wx" });
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
  }
  if (isLocalEmbeddingsRunning(baseDir)) return false;
  try {
    writeFileSync(lockPath, body, { flag: "wx" });
    return true;
  } catch {
    return false;
  }
}

export function transferLocalEmbeddingsLock(pid: number, baseDir: string = localEmbeddingsBaseDir()): void {
  const { lockPath } = localEmbeddingsPaths(baseDir);
  const info = readJson<Record<string, unknown>>(lockPath);
  if (!info) return;
  try {
    writeFileSync(lockPath, JSON.stringify({ ...info, pid }));
  } catch {
    /* released meanwhile */
  }
}

export function releaseLocalEmbeddingsLock(baseDir: string = localEmbeddingsBaseDir()): void {
  try {
    unlinkSync(localEmbeddingsPaths(baseDir).lockPath);
  } catch {
    /* already gone */
  }
}

// ---------------------------------------------------------------------------
// Public status (GET /api/llm, GET /api/llm/embeddings)
// ---------------------------------------------------------------------------

export type LocalEmbeddingsState = "not-applicable" | "ready" | "needed" | "running" | "failed";

export interface LocalEmbeddingsStatus {
  /** "not-applicable": embeddings are configured in .env.local, so the app leaves them alone. */
  state: LocalEmbeddingsState;
  model: string;
  /** Search is using the local index right now. */
  active: boolean;
  /** Ready, but built from an older corpus than the one the app now serves. */
  outdated?: boolean;
  count?: number;
  progress?: { stage: LocalEmbeddingsStage; done?: number; total?: number; pct?: number };
  error?: string;
  errorKind?: LocalEmbeddingsErrorKind;
  finishedAt?: string;
}

/** Pure: the status the UI renders, from everything on disk. */
export function deriveLocalEmbeddingsStatus(input: {
  provider: "ollama" | "cloud";
  envIsHosted: boolean;
  meta: LocalIndexMeta | null;
  sourceMeta: { builtAt?: unknown; count?: unknown } | null;
  running: boolean;
  job: LocalEmbeddingsJob;
  model?: string;
}): LocalEmbeddingsStatus {
  const model = input.model ?? LOCAL_EMBED_MODEL;
  if (!input.envIsHosted) return { state: "not-applicable", model, active: false };

  const ready = isLocalIndexReady(input.meta, model);
  const base: LocalEmbeddingsStatus = {
    state: "needed",
    model,
    active: shouldUseLocalIndex({ provider: input.provider, envIsHosted: input.envIsHosted, ready }),
    ...(ready ? { count: input.meta!.count, outdated: isLocalIndexOutdated(input.meta, input.sourceMeta) } : {}),
    ...(input.job.finishedAt ? { finishedAt: input.job.finishedAt } : {}),
  };

  if (input.running) {
    const { stage = "checking", done, total, pct } = input.job;
    return {
      ...base,
      state: "running",
      progress: {
        stage,
        ...(done != null ? { done } : {}),
        ...(total != null ? { total } : {}),
        ...(pct != null ? { pct } : {}),
      },
    };
  }
  // A failed attempt is only news while there's no finished index to fall back on, or when it's newer than that index.
  const failedAfterReady = input.job.lastError && (!ready || (input.job.lastFailedAt ?? "") > (input.meta?.embeddedAt ?? ""));
  if (input.job.lastError && failedAfterReady) {
    return { ...base, state: "failed", error: input.job.lastError, errorKind: input.job.errorKind ?? "unknown" };
  }
  if (ready) return { ...base, state: "ready" };
  return base;
}

export function buildLocalEmbeddingsStatus(baseDir: string = localEmbeddingsBaseDir()): LocalEmbeddingsStatus {
  return deriveLocalEmbeddingsStatus({
    provider: resolveProvider(),
    envIsHosted: envEmbeddingsAreHosted(),
    meta: readLocalIndexMeta(baseDir),
    sourceMeta: readJson(sourceCorpusPaths(baseDir).metaPath),
    running: isLocalEmbeddingsRunning(baseDir),
    job: readLocalEmbeddingsJob(baseDir),
  });
}

/** Pure: start the background job without being asked? Only for Local, and only when there's something to do. */
export function shouldAutoStart(status: LocalEmbeddingsStatus, provider: "ollama" | "cloud"): boolean {
  if (provider !== "ollama") return false;
  if (status.state === "needed" || status.state === "failed") return true;
  return status.state === "ready" && status.outdated === true;
}
