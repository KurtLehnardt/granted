import { existsSync, statSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { normalizeOpenAiBaseUrl } from "../llm/baseUrl";
import { resolveProvider } from "../llm/config";
import { readJsonFile, writeFileAtomic } from "../fs/atomicFile";
import { createPidLock } from "../fs/pidLock";

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
    /** The detached job's stdout/stderr, so an early crash (e.g. tsx missing) can be shown. */
    logPath: join(localDir, "local-embeddings-job.log"),
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

/**
 * Is the local model server Ollama? Settings' "Local (Ollama)" and LLM_PROVIDER=ollama
 * (or unset) mean yes. LLM_PROVIDER=openai/local means a generic OpenAI-compatible
 * server (LM Studio, vLLM, llama.cpp), which has no /api/tags or /api/pull, so the
 * app can't set up embeddings there and says so instead of a misleading
 * "couldn't reach Ollama".
 */
export function localServerIsOllama(llmProviderEnv: string | undefined = process.env.LLM_PROVIDER): boolean {
  const v = (llmProviderEnv ?? "").trim().toLowerCase();
  return v === "" || v === "ollama" || v === "anthropic";
}

export const MANUAL_EMBEDDINGS_MESSAGE =
  "Your local model server isn't Ollama, so Granted can't set up local search for you. Point EMBEDDINGS_BASE_URL and " +
  "EMBEDDINGS_MODEL in scaffold/.env.local at an embedding model on that server, then run `npm run data:embed:local` " +
  "(see the README's 'Fully offline' section).";

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
  const meta = readJsonFile<LocalIndexMeta>(metaPath);
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

/**
 * THE one readiness decision for search: lib/corpus/store.ts picks the corpus with it,
 * and lib/match.ts embeds the query with the target matching whichever corpus was
 * actually loaded. Ready = a complete meta AND the index file present, both under `baseDir`.
 */
export function localEmbeddingsActive(baseDir: string = localEmbeddingsBaseDir()): boolean {
  return shouldUseLocalIndex({
    provider: resolveProvider(),
    envIsHosted: envEmbeddingsAreHosted(),
    ready: isLocalIndexReady(readLocalIndexMeta(baseDir)) && existsSync(localEmbeddingsPaths(baseDir).oppsPath),
  });
}

// ---------------------------------------------------------------------------
// Background job: progress/error file + single-flight lock
// ---------------------------------------------------------------------------

export type LocalEmbeddingsStage = "checking" | "pulling" | "embedding" | "saving";
export type LocalEmbeddingsErrorKind =
  | "ollama-unreachable"
  | "not-ollama"
  | "pull-failed"
  | "embed-failed"
  | "timeout"
  | "crashed"
  | "unknown";

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
  return readJsonFile<LocalEmbeddingsJob>(localEmbeddingsPaths(baseDir).jobPath) ?? {};
}

export function writeLocalEmbeddingsJob(job: LocalEmbeddingsJob, baseDir: string = localEmbeddingsBaseDir()): void {
  // Cosmetic progress file: a Windows reader holding it open falls back to a direct write.
  writeFileAtomic(localEmbeddingsPaths(baseDir).jobPath, JSON.stringify(job, null, 2), { fallback: "direct" });
}

/** Single-flight lock (lib/fs/pidLock.ts): an unreadable lock counts as held, never deleted. */
function jobLock(baseDir: string) {
  return createPidLock(localEmbeddingsPaths(baseDir).lockPath);
}

export function isLocalEmbeddingsRunning(baseDir: string = localEmbeddingsBaseDir()): boolean {
  return jobLock(baseDir).isHeld();
}

export function acquireLocalEmbeddingsLock(baseDir: string = localEmbeddingsBaseDir(), pid: number = process.pid): boolean {
  return jobLock(baseDir).acquire(pid);
}

export function transferLocalEmbeddingsLock(pid: number, baseDir: string = localEmbeddingsBaseDir()): void {
  jobLock(baseDir).transfer(pid);
}

export function releaseLocalEmbeddingsLock(baseDir: string = localEmbeddingsBaseDir()): void {
  jobLock(baseDir).release();
}

// ---------------------------------------------------------------------------
// Public status (GET /api/llm, GET /api/llm/embeddings)
// ---------------------------------------------------------------------------

export type LocalEmbeddingsState = "not-applicable" | "manual" | "ready" | "needed" | "running" | "failed";

export interface LocalEmbeddingsStatus {
  /**
   * "not-applicable": embeddings are configured in .env.local, so the app leaves them alone.
   * "manual": Local runs on a non-Ollama server; embeddings must be set up by hand (`error` says how).
   */
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
  /** Defaults to true. False: Local runs on a non-Ollama server (see localServerIsOllama). */
  ollamaBackend?: boolean;
  meta: LocalIndexMeta | null;
  sourceMeta: { builtAt?: unknown; count?: unknown } | null;
  running: boolean;
  job: LocalEmbeddingsJob;
  model?: string;
}): LocalEmbeddingsStatus {
  const model = input.model ?? LOCAL_EMBED_MODEL;
  if (!input.envIsHosted) return { state: "not-applicable", model, active: false };
  if (input.provider === "ollama" && input.ollamaBackend === false) {
    return { state: "manual", model, active: false, error: MANUAL_EMBEDDINGS_MESSAGE };
  }

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
  // Started (stage written) but no longer running, with no outcome recorded: the job died
  // (import crash, tsx missing under `next start`, killed). Never silently fall back to "needed".
  if (input.job.stage && !input.job.lastError) {
    return {
      ...base,
      state: "failed",
      errorKind: "crashed",
      error:
        "Local search setup stopped unexpectedly before finishing. Click Retry. If it keeps happening, " +
        "scaffold/data/local/local-embeddings-job.log has the details.",
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
    ollamaBackend: localServerIsOllama(),
    meta: readLocalIndexMeta(baseDir),
    sourceMeta: readJsonFile(sourceCorpusPaths(baseDir).metaPath),
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
