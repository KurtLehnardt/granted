/**
 * The corpus-embedding loop, shared by scripts/3-embed.mjs (`npm run data:embed`,
 * `data:embed:local`) and the Settings-driven local re-embed
 * (lib/embeddings/localEmbedJob.ts). Plain .mjs so 3-embed.mjs keeps running
 * under bare `node` (no tsx).
 *
 * Everything that talks to the network takes an injectable `fetchFn` / `sleepFn`
 * so tests never need a live embedder.
 */

/** Text embedded per program. Must match lib/corpus/refresh.ts's opportunityEmbedText. */
export function corpusEmbedText(o) {
  return `${o.program}. ${o.agency}. ${o.description}`.slice(0, 8000);
}

/** OpenAI-compatible /embeddings body. `dimensions` only for models that accept it (OpenAI text-embedding-3-*). */
export function embeddingsBody(model, dimensions, inputs) {
  return JSON.stringify(dimensions != null ? { model, dimensions, input: inputs } : { model, input: inputs });
}

/** Five-decimal rounding keeps the corpus JSON compact without changing retrieval. */
export function roundVector(v) {
  return v.map((x) => Math.round(x * 1e5) / 1e5);
}

/**
 * POST one batch to `${baseUrl}/embeddings`, retrying with exponential backoff on
 * 429/5xx (honors Retry-After). Returns the response's `data` array sorted by index.
 * `timeoutMs` (optional) bounds each request, body included; a stalled server then
 * fails with an EmbeddingsTimeoutError instead of hanging forever.
 *
 * @param {{
 *   baseUrl: string, model: string, dimensions?: number, key?: string, inputs: string[],
 *   fetchFn?: typeof fetch, sleepFn?: (ms: number) => Promise<void>,
 *   onRetry?: (info: { status: number, waitMs: number, attempt: number }) => void,
 *   maxRetries?: number, timeoutMs?: number,
 * }} opts
 */
export async function postEmbeddings(opts, attempt = 0) {
  const { baseUrl, model, dimensions, key = "local", inputs, fetchFn = fetch, maxRetries = 7, timeoutMs } = opts;
  const sleep = opts.sleepFn || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const ac = timeoutMs ? new AbortController() : null;
  let timedOut = false;
  const timer = ac
    ? setTimeout(() => {
        timedOut = true;
        ac.abort();
      }, timeoutMs)
    : null;
  try {
    return await postOnce();
  } catch (e) {
    if (timedOut) throw new EmbeddingsTimeoutError(timeoutMs, baseUrl);
    throw e;
  } finally {
    if (timer) clearTimeout(timer);
  }

  async function postOnce() {
  const res = await fetchFn(`${baseUrl}/embeddings`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: embeddingsBody(model, dimensions, inputs),
    ...(ac ? { signal: ac.signal } : {}),
  });

  if (res.status === 429 || res.status >= 500) {
    if (attempt >= maxRetries) throw new Error(`Gave up after ${attempt} retries (${res.status}): ${await res.text()}`);
    const ra = Number(res.headers?.get?.("retry-after"));
    const waitMs = Number.isFinite(ra) && ra > 0 ? ra * 1000 : Math.min(60000, 1000 * 2 ** attempt);
    opts.onRetry?.({ status: res.status, waitMs, attempt: attempt + 1 });
    if (timer) clearTimeout(timer); // this attempt answered; the retry gets its own timeout
    await sleep(waitMs);
    return postEmbeddings(opts, attempt + 1);
  }
  if (!res.ok) throw new Error(`Embeddings failed (${res.status}) at ${baseUrl}: ${await res.text()}`);
  const json = await res.json();
  const data = Array.isArray(json?.data) ? json.data.slice() : [];
  if (data.length !== inputs.length) {
    throw new Error(`Embeddings returned ${data.length} vectors for ${inputs.length} inputs at ${baseUrl}`);
  }
  if (data.every((d) => typeof d?.index === "number")) data.sort((a, b) => a.index - b.index);
  return data;
  }
}

/** A request to the embedder took longer than its `timeoutMs`. */
export class EmbeddingsTimeoutError extends Error {
  constructor(timeoutMs, baseUrl) {
    super(`The embedding server at ${baseUrl} didn't answer within ${Math.round(timeoutMs / 1000)}s`);
    this.name = "EmbeddingsTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Embed every record in `opps` IN PLACE (sets `.embedding`), `batch` at a time.
 * `onProgress(done, total)` fires after each batch; `shouldStop()` (optional) is
 * checked between batches and aborts with an Error when it returns true.
 *
 * @param {Array<{program: string, agency: string, description: string, embedding?: number[]}>} opps
 * @param {{
 *   baseUrl: string, model: string, dimensions?: number, key?: string, batch?: number,
 *   interBatchDelayMs?: number, fetchFn?: typeof fetch, sleepFn?: (ms: number) => Promise<void>,
 *   maxRetries?: number, timeoutMs?: number,
 *   onProgress?: (done: number, total: number) => void,
 *   onRetry?: (info: { status: number, waitMs: number, attempt: number }) => void,
 *   shouldStop?: () => boolean,
 * }} opts
 */
export async function embedOpportunities(opps, opts) {
  const { batch = 32, interBatchDelayMs = 0, onProgress, shouldStop } = opts;
  const sleep = opts.sleepFn || ((ms) => new Promise((r) => setTimeout(r, ms)));
  let done = 0;
  for (let i = 0; i < opps.length; i += batch) {
    if (shouldStop?.()) throw new Error("Stopped before finishing.");
    const slice = opps.slice(i, i + batch);
    const data = await postEmbeddings({ ...opts, inputs: slice.map(corpusEmbedText) });
    data.forEach((d, k) => {
      slice[k].embedding = roundVector(d.embedding);
    });
    done += slice.length;
    onProgress?.(done, opps.length);
    if (interBatchDelayMs > 0 && done < opps.length) await sleep(interBatchDelayMs);
  }
  return opps;
}

/** Length of the first non-empty embedding in `opps`, or undefined. */
export function corpusDims(opps) {
  return opps.find((o) => Array.isArray(o.embedding) && o.embedding.length > 0)?.embedding?.length;
}
