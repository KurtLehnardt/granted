import { mkdirSync } from "node:fs";
import { embedOpportunities, corpusDims, EmbeddingsTimeoutError } from "../../scripts/lib/embedCorpus.mjs";
import { embedWithRetry } from "../../scripts/setup-local.mjs";
import { opportunityEmbedText, planEmbedding, type PriorEmbeddingEntry } from "../corpus/refresh";
import { readJsonFile, writeFileAtomic } from "../fs/atomicFile";
import type { Opportunity } from "../types";
import {
  LOCAL_EMBED_MODEL,
  MANUAL_EMBEDDINGS_MESSAGE,
  isLocalIndexReady,
  localEmbeddingsPaths,
  localOllamaUrls,
  localServerIsOllama,
  readLocalEmbeddingsJob,
  sourceCorpusPaths,
  writeLocalEmbeddingsJob,
  type LocalEmbeddingsErrorKind,
  type LocalEmbeddingsJob,
  type LocalIndexMeta,
} from "./localEmbeddings";

/**
 * The background job behind Settings → Local: make search run on a local
 * embedding model with no terminal. Run by scripts/local-embeddings-job.mjs in a
 * detached child (spawned by POST /api/llm/embeddings, a switch to Local, or the
 * end of data:refresh), so it survives dev-server reloads and never blocks a request.
 *
 *   1. checking  — is the local server Ollama, is it reachable, is nomic-embed-text pulled?
 *   2. pulling   — if not, pull it via Ollama's /api/pull (streamed progress)
 *   3. embedding — warm the model, then re-embed the hosted corpus with it,
 *                  reusing vectors from a previous local index for unchanged
 *                  records (lib/corpus/refresh.ts's planEmbedding)
 *   4. saving    — write data/local/local-embeddings/opportunities.json, then
 *                  corpus-meta.json LAST (`complete: true` is the ready signal)
 *
 * Every network step has a timeout, so a stalled Ollama ends in a Retry-able
 * "timeout" error (and releases the lock) instead of "running" forever.
 *
 * Progress and plain-language failures go to data/local/local-embeddings-job.json.
 * Nothing the hosted path reads is ever written, so a failure at any step leaves
 * the current search setup exactly as it was.
 *
 * Every side effect is injectable; the unit tests stub Ollama with a fake fetch.
 */

export interface LocalEmbedJobDeps {
  baseDir: string;
  fetchFn?: typeof fetch;
  sleepFn?: (ms: number) => Promise<void>;
  now?: () => Date;
  model?: string;
  ollama?: { openAiBaseUrl: string; nativeBaseUrl: string };
  /** Defaults to localServerIsOllama(): false (LLM_PROVIDER=openai/local) fails fast with the manual-setup message. */
  ollamaBackend?: boolean;
  batch?: number;
  retryDelayMs?: number;
  /** No bytes from /api/pull for this long ends the pull with a "timeout" error. Default 2 min. */
  pullIdleTimeoutMs?: number;
  /** Per /v1/embeddings request (one batch). Default 3 min, generous for a slow CPU. */
  embedRequestTimeoutMs?: number;
  writeJob?: (job: LocalEmbeddingsJob) => void;
}

export class LocalEmbedJobError extends Error {
  constructor(
    readonly kind: LocalEmbeddingsErrorKind,
    message: string,
  ) {
    super(message);
  }
}

function brief(detail: unknown): string {
  const s = String((detail as Error)?.message ?? detail ?? "").replace(/\s+/g, " ").trim();
  return s.length > 200 ? `${s.slice(0, 197)}...` : s;
}

const minutes = (ms: number) => (ms >= 60_000 ? `${Math.round(ms / 60_000)} minute${ms >= 120_000 ? "s" : ""}` : `${Math.max(1, Math.round(ms / 1000))} seconds`);

async function withTimeout<T>(ms: number, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  try {
    return await fn(ac.signal);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Names of the models Ollama has pulled. Throws "ollama-unreachable" when nothing
 * answers, and "not-ollama" when something answers but has no /api/tags (LM Studio etc.).
 */
export async function listOllamaModels(nativeBaseUrl: string, fetchFn: typeof fetch = fetch): Promise<string[]> {
  let res: Response;
  let json: any;
  try {
    res = await withTimeout(5000, async (signal) => {
      const r = await fetchFn(`${nativeBaseUrl}/api/tags`, { signal });
      json = r.ok ? await r.json().catch(() => undefined) : undefined;
      return r;
    });
  } catch {
    throw new LocalEmbedJobError(
      "ollama-unreachable",
      `Couldn't reach Ollama at ${nativeBaseUrl}. Make sure Ollama is installed and running (open the Ollama app), then click Retry.`,
    );
  }
  if (!res.ok || !Array.isArray(json?.models)) {
    if (res.status >= 500) {
      throw new LocalEmbedJobError("ollama-unreachable", `Ollama at ${nativeBaseUrl} returned an error (HTTP ${res.status}). Click Retry.`);
    }
    throw new LocalEmbedJobError("not-ollama", MANUAL_EMBEDDINGS_MESSAGE);
  }
  return json.models.map((m: { name?: unknown; model?: unknown }) => String(m?.name ?? m?.model ?? "")).filter(Boolean);
}

/** Ollama names a pulled model "nomic-embed-text:latest"; a bare tag means :latest. */
export function hasModel(installed: string[], model: string): boolean {
  const want = model.includes(":") ? model : `${model}:latest`;
  return installed.some((name) => name === model || name === want);
}

/** One line of /api/pull's NDJSON stream → pct (0–100) when it carries byte counts. */
export function pullLinePct(line: { total?: number; completed?: number }): number | undefined {
  if (typeof line.total !== "number" || line.total <= 0 || typeof line.completed !== "number") return undefined;
  return Math.max(0, Math.min(100, Math.round((line.completed / line.total) * 100)));
}

/**
 * Pull `model` through Ollama's /api/pull, reporting progress. Throws "pull-failed",
 * or "timeout" when Ollama sends nothing (no response, or no new bytes on the
 * stream) for `idleTimeoutMs`.
 */
export async function pullOllamaModel(
  nativeBaseUrl: string,
  model: string,
  onProgress: (pct: number | undefined) => void,
  fetchFn: typeof fetch = fetch,
  idleTimeoutMs: number = 120_000,
): Promise<void> {
  const fail = (detail: unknown) =>
    new LocalEmbedJobError(
      "pull-failed",
      `Couldn't download the local search model (${model}) through Ollama${detail ? `: ${brief(detail)}` : ""}. Check your internet connection and that Ollama is running, then click Retry.`,
    );
  const ac = new AbortController();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const armIdleTimer = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      timedOut = true;
      ac.abort();
    }, idleTimeoutMs);
  };
  const stalled = () =>
    new LocalEmbedJobError(
      "timeout",
      `Ollama stopped responding while downloading the local search model (${model}): nothing arrived for ${minutes(idleTimeoutMs)}. Click Retry; Ollama resumes the download where it left off.`,
    );

  armIdleTimer();
  try {
    let res: Response;
    try {
      res = await fetchFn(`${nativeBaseUrl}/api/pull`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model, stream: true }),
        signal: ac.signal,
      });
    } catch (e) {
      throw timedOut ? stalled() : fail(e);
    }
    if (!res.ok) throw fail(`HTTP ${res.status} ${await res.text().catch(() => "")}`);

    let sawSuccess = false;
    const handleLine = (raw: string) => {
      const text = raw.trim();
      if (!text) return;
      let line: { status?: string; error?: string; total?: number; completed?: number };
      try {
        line = JSON.parse(text);
      } catch {
        return;
      }
      if (line.error) throw fail(line.error);
      if (line.status === "success") sawSuccess = true;
      onProgress(pullLinePct(line));
    };

    if (res.body && typeof (res.body as ReadableStream).getReader === "function") {
      const reader = (res.body as ReadableStream<Uint8Array>).getReader();
      // Some fetch implementations don't abort a body read on signal; cancel the reader too.
      ac.signal.addEventListener("abort", () => void reader.cancel().catch(() => {}), { once: true });
      const decoder = new TextDecoder();
      let buf = "";
      for (;;) {
        let chunk: ReadableStreamReadResult<Uint8Array>;
        try {
          chunk = await reader.read();
        } catch (e) {
          throw timedOut ? stalled() : fail(e);
        }
        if (timedOut) throw stalled();
        if (chunk.done) break;
        armIdleTimer(); // bytes arrived: Ollama is alive
        buf += decoder.decode(chunk.value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        lines.forEach(handleLine);
      }
      handleLine(buf + decoder.decode());
    } else {
      let text: string;
      try {
        text = await res.text();
      } catch (e) {
        throw timedOut ? stalled() : fail(e);
      }
      text.split("\n").forEach(handleLine);
    }
    if (!sawSuccess) throw fail("the download ended before Ollama reported success");
  } finally {
    clearTimeout(timer);
  }
}

/** Runs the whole job. Resolves true on success; on failure records a plain-language error and resolves false. Never throws. */
export async function runLocalEmbedJob(deps: LocalEmbedJobDeps): Promise<boolean> {
  const fetchFn = deps.fetchFn ?? fetch;
  const sleepFn = deps.sleepFn ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? (() => new Date());
  const model = deps.model ?? LOCAL_EMBED_MODEL;
  const ollama = deps.ollama ?? localOllamaUrls();
  const embedTimeoutMs = deps.embedRequestTimeoutMs ?? 180_000;
  const writeJob = deps.writeJob ?? ((job: LocalEmbeddingsJob) => writeLocalEmbeddingsJob(job, deps.baseDir));
  const paths = localEmbeddingsPaths(deps.baseDir);
  const previous = readLocalEmbeddingsJob(deps.baseDir);
  const startedAt = now().toISOString();

  // Progress writes are cosmetic: never let one fail the job.
  const report = (patch: LocalEmbeddingsJob) => {
    try {
      writeJob({ startedAt, ...(previous.finishedAt ? { finishedAt: previous.finishedAt } : {}), ...patch });
    } catch {
      /* ignore */
    }
  };

  try {
    report({ stage: "checking" });
    if (!(deps.ollamaBackend ?? localServerIsOllama())) throw new LocalEmbedJobError("not-ollama", MANUAL_EMBEDDINGS_MESSAGE);
    const installed = await listOllamaModels(ollama.nativeBaseUrl, fetchFn);

    if (!hasModel(installed, model)) {
      report({ stage: "pulling", pct: 0 });
      let lastPct = -1;
      await pullOllamaModel(
        ollama.nativeBaseUrl,
        model,
        (pct) => {
          if (pct == null || pct === lastPct) return;
          lastPct = pct;
          report({ stage: "pulling", pct });
        },
        fetchFn,
        deps.pullIdleTimeoutMs,
      );
    }

    // Source: the corpus the hosted path serves. Prior: a previous local index, for vector reuse.
    const source = sourceCorpusPaths(deps.baseDir);
    const incoming = readJsonFile<Opportunity[]>(source.oppsPath);
    if (!Array.isArray(incoming) || incoming.length === 0) {
      throw new LocalEmbedJobError("unknown", `The grant corpus at ${source.oppsPath} is missing or empty, so there's nothing to index.`);
    }
    const sourceMeta = readJsonFile<{ builtAt?: string; count?: number }>(source.metaPath) ?? {};
    const priorMeta = readJsonFile<LocalIndexMeta>(paths.metaPath);
    const prior = isLocalIndexReady(priorMeta, model) ? (readJsonFile<Opportunity[]>(paths.oppsPath) ?? []) : [];
    const priorById = new Map<string, PriorEmbeddingEntry>();
    for (const o of prior) {
      if (o?.id && Array.isArray(o.embedding)) priorById.set(o.id, { embedding: o.embedding, text: opportunityEmbedText(o) });
    }
    const plan = planEmbedding(incoming, priorById, priorById.size ? model : undefined, model, priorMeta?.dims, priorMeta?.dims);
    const total = incoming.length;
    const reusedCount = plan.reused.length;
    // Records embedded so far IN THIS JOB: a retry only embeds the rest, and progress never goes backwards.
    const embeddedNow = new Set<Opportunity>();
    const progressReport = () => {
      const done = reusedCount + embeddedNow.size;
      report({ stage: "embedding", done, total, pct: Math.round((done / total) * 100) });
    };
    progressReport();

    let lastFailure: unknown;
    const result = await embedWithRetry({
      waitFn: sleepFn,
      retryDelayMs: deps.retryDelayMs ?? 5000,
      // One small request first: a cold model's first call can be slow enough to fail the real run.
      warmFn: async () => {
        try {
          await withTimeout(60_000, (signal) =>
            fetchFn(`${ollama.openAiBaseUrl}/embeddings`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ model, input: "warmup" }),
              signal,
            }),
          );
          return true;
        } catch {
          return false;
        }
      },
      runFn: async () => {
        const remaining = plan.toEmbed.filter((o) => !embeddedNow.has(o));
        try {
          await embedOpportunities(remaining, {
            baseUrl: ollama.openAiBaseUrl,
            model,
            key: "local",
            batch: deps.batch ?? 32,
            fetchFn,
            sleepFn,
            maxRetries: 3,
            timeoutMs: embedTimeoutMs,
            onProgress: (n: number) => {
              // embedOpportunities finishes records in order: the first n of `remaining` are done.
              for (const o of remaining.slice(0, n)) embeddedNow.add(o);
              progressReport();
            },
          });
          return { ok: true, output: "" };
        } catch (e) {
          lastFailure = e;
          return { ok: false, output: brief(e) };
        }
      },
    });
    if (!result.ok) {
      if (lastFailure instanceof EmbeddingsTimeoutError) {
        throw new LocalEmbedJobError(
          "timeout",
          `Ollama stopped responding while building the local search index (a batch took longer than ${minutes(embedTimeoutMs)}). ` +
            "Make sure Ollama is still running, then click Retry; your current search setup is unchanged.",
        );
      }
      throw new LocalEmbedJobError(
        "embed-failed",
        `Building the local search index failed${result.output ? `: ${result.output}` : ""}. Click Retry; your current search setup is unchanged.`,
      );
    }

    report({ stage: "saving", done: total, total, pct: 100 });
    const byId = new Map<string, number[] | undefined>();
    for (const o of [...plan.reused, ...plan.toEmbed]) byId.set(o.id, o.embedding);
    const out = incoming.map((o) => ({ ...o, embedding: byId.get(o.id) ?? o.embedding }));
    const dims = corpusDims(out);
    if (!dims || out.some((o) => !Array.isArray(o.embedding) || o.embedding.length !== dims)) {
      throw new LocalEmbedJobError("embed-failed", "The local embedding model returned vectors of inconsistent size. Click Retry.");
    }

    mkdirSync(paths.dir, { recursive: true });
    // fallback "throw": the store must never read a half-written index (a failed write is a Retry-able error).
    writeFileAtomic(paths.oppsPath, JSON.stringify(out), { fallback: "throw" });
    const finishedAt = now().toISOString();
    const meta: LocalIndexMeta = {
      complete: true,
      embeddingModel: model,
      dims,
      count: out.length,
      ...(typeof sourceMeta.builtAt === "string" ? { builtAt: sourceMeta.builtAt } : {}),
      sourceBuiltAt: typeof sourceMeta.builtAt === "string" ? sourceMeta.builtAt : null,
      ...(typeof sourceMeta.count === "number" ? { sourceCount: sourceMeta.count } : {}),
      embeddedAt: finishedAt,
      reused: reusedCount,
      note: "Local search index built from Settings → Local (lib/embeddings/localEmbedJob.ts). Gitignored. builtAt is carried over from the source corpus.",
    };
    writeFileAtomic(paths.metaPath, JSON.stringify(meta, null, 2) + "\n", { fallback: "throw" }); // LAST: the ready signal
    try {
      writeJob({ startedAt, finishedAt });
    } catch {
      /* the index is written; a stale progress file only shows until the next poll */
    }
    return true;
  } catch (e) {
    const kind: LocalEmbeddingsErrorKind = e instanceof LocalEmbedJobError ? e.kind : "unknown";
    const message =
      e instanceof LocalEmbedJobError
        ? e.message
        : `Setting up local search failed unexpectedly: ${brief(e)}. Click Retry; your current search setup is unchanged.`;
    try {
      writeJob({
        startedAt,
        ...(previous.finishedAt ? { finishedAt: previous.finishedAt } : {}),
        lastError: message,
        errorKind: kind,
        lastFailedAt: now().toISOString(),
      });
    } catch {
      /* nothing more we can do */
    }
    return false;
  }
}
