import { describe, test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runLocalEmbedJob, hasModel, pullLinePct, type LocalEmbedJobDeps } from "../localEmbedJob";
import { localEmbeddingsPaths, readLocalEmbeddingsJob, isLocalIndexReady, type LocalEmbeddingsJob } from "../localEmbeddings";

/**
 * The Settings → Local background job, against a fake Ollama (injected fetch):
 * no network, no live Ollama, no API keys.
 */

const OLLAMA = { openAiBaseUrl: "http://ollama.test/v1", nativeBaseUrl: "http://ollama.test" };
const DIMS = 4;

type FakeOllama = {
  installed?: string[];
  down?: boolean;
  pullLines?: object[];
  pullStatus?: number;
  /** Return a status for the Nth /v1/embeddings call (1-based), or undefined for success. */
  embedFail?: (n: number) => number | undefined;
};

function fakeOllama(opts: FakeOllama = {}) {
  const log: string[] = [];
  const embeddedInputs: string[] = [];
  let embedCalls = 0;
  let installed = [...(opts.installed ?? [])];
  const fetchFn = (async (url: string, init?: { method?: string; body?: string }) => {
    const path = url.replace(/^http:\/\/ollama\.test/, "");
    log.push(`${init?.method ?? "GET"} ${path}`);
    if (opts.down) throw new TypeError("fetch failed: connect ECONNREFUSED");
    if (path === "/api/tags") return new Response(JSON.stringify({ models: installed.map((name) => ({ name })) }));
    if (path === "/api/pull") {
      const lines = opts.pullLines ?? [
        { status: "pulling manifest" },
        { status: "pulling abc", total: 1000, completed: 250 },
        { status: "pulling abc", total: 1000, completed: 1000 },
        { status: "success" },
      ];
      if ((lines as Array<{ status?: string }>).some((l) => l.status === "success")) installed.push("nomic-embed-text:latest");
      return new Response(lines.map((l) => JSON.stringify(l)).join("\n") + "\n", { status: opts.pullStatus ?? 200 });
    }
    if (path === "/v1/embeddings") {
      const body = JSON.parse(init!.body!);
      if (body.input === "warmup") return new Response(JSON.stringify({ data: [{ embedding: Array(DIMS).fill(0) }] }));
      embedCalls++;
      const fail = opts.embedFail?.(embedCalls);
      if (fail) return new Response("model crashed", { status: fail });
      assert.equal(body.model, "nomic-embed-text");
      assert.equal(body.dimensions, undefined, "local models are fixed-size; never send `dimensions`");
      embeddedInputs.push(...body.input);
      return new Response(JSON.stringify({ data: body.input.map((_: string, i: number) => ({ index: i, embedding: Array(DIMS).fill(0.5) })) }));
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
  return { fetchFn, log, embeddedInputs, get embedCalls() { return embedCalls; } };
}

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const HOSTED_OPPS = [1, 2, 3, 4, 5].map((i) => ({ id: `g${i}`, program: `P${i}`, agency: "A", description: "D", embedding: [0.1, 0.2] }));
const HOSTED_META = { builtAt: "2026-09-01T00:00:00.000Z", count: 5 };

function seed() {
  const baseDir = mkdtempSync(join(tmpdir(), "granted-local-embed-job-"));
  dirs.push(baseDir);
  mkdirSync(join(baseDir, "data"), { recursive: true });
  writeFileSync(join(baseDir, "data", "opportunities.json"), JSON.stringify(HOSTED_OPPS));
  writeFileSync(join(baseDir, "data", "corpus-meta.json"), JSON.stringify(HOSTED_META));
  return baseDir;
}

function deps(baseDir: string, fetchFn: typeof fetch, extra: Partial<LocalEmbedJobDeps> = {}) {
  const jobs: LocalEmbeddingsJob[] = [];
  const d: LocalEmbedJobDeps = {
    baseDir,
    fetchFn,
    ollama: OLLAMA,
    batch: 2,
    sleepFn: async () => {},
    retryDelayMs: 0,
    now: () => new Date("2026-10-04T12:00:00.000Z"),
    writeJob: (job) => {
      jobs.push(job);
      writeFileSync(localEmbeddingsPaths(baseDir).jobPath, JSON.stringify(job));
    },
    ...extra,
  };
  mkdirSync(localEmbeddingsPaths(baseDir).localDir, { recursive: true });
  return { d, jobs };
}

const readJson = (p: string) => JSON.parse(readFileSync(p, "utf8"));

describe("runLocalEmbedJob", () => {
  test("model already pulled: no pull, embeds the hosted corpus into the separate local index, meta marks it ready", async () => {
    const baseDir = seed();
    const ollama = fakeOllama({ installed: ["llama3.2:1b", "nomic-embed-text:latest"] });
    const { d, jobs } = deps(baseDir, ollama.fetchFn);

    assert.equal(await runLocalEmbedJob(d), true);
    assert.ok(!ollama.log.includes("POST /api/pull"));
    assert.equal(ollama.embedCalls, 3); // 5 records, batch 2

    const p = localEmbeddingsPaths(baseDir);
    const out = readJson(p.oppsPath);
    assert.deepEqual(out.map((o: { id: string }) => o.id), ["g1", "g2", "g3", "g4", "g5"]);
    assert.ok(out.every((o: { embedding: number[] }) => o.embedding.length === DIMS));
    const meta = readJson(p.metaPath);
    assert.equal(isLocalIndexReady(meta), true);
    assert.equal(meta.dims, DIMS);
    assert.equal(meta.count, 5);
    assert.equal(meta.builtAt, HOSTED_META.builtAt, "re-embedding doesn't make the grants newer");
    assert.equal(meta.sourceBuiltAt, HOSTED_META.builtAt);
    assert.equal(meta.sourceCount, 5);

    // The hosted corpus is untouched: switching back to Cloud needs no rebuild.
    assert.deepEqual(readJson(join(baseDir, "data", "opportunities.json")), HOSTED_OPPS);

    assert.deepEqual(
      jobs.map((j) => j.stage ?? "done"),
      ["checking", "embedding", "embedding", "embedding", "embedding", "saving", "done"],
    );
    assert.equal(jobs.at(-1)!.finishedAt, "2026-10-04T12:00:00.000Z");
    assert.equal(jobs.at(-1)!.lastError, undefined);
  });

  test("model missing: pulls it through /api/pull with progress, then embeds", async () => {
    const baseDir = seed();
    const ollama = fakeOllama({ installed: ["llama3.2:1b"] });
    const { d, jobs } = deps(baseDir, ollama.fetchFn);

    assert.equal(await runLocalEmbedJob(d), true);
    assert.ok(ollama.log.includes("POST /api/pull"));
    const pulling = jobs.filter((j) => j.stage === "pulling").map((j) => j.pct);
    assert.deepEqual(pulling, [0, 25, 100]);
    assert.equal(isLocalIndexReady(readJson(localEmbeddingsPaths(baseDir).metaPath)), true);
  });

  test("Ollama not running → 'ollama-unreachable' in plain language, nothing written to the index", async () => {
    const baseDir = seed();
    const { d } = deps(baseDir, fakeOllama({ down: true }).fetchFn);

    assert.equal(await runLocalEmbedJob(d), false);
    const job = readLocalEmbeddingsJob(baseDir);
    assert.equal(job.errorKind, "ollama-unreachable");
    assert.match(job.lastError!, /Couldn't reach Ollama at http:\/\/ollama\.test.*open the Ollama app.*Retry/);
    assert.equal(job.lastFailedAt, "2026-10-04T12:00:00.000Z");
    assert.equal(existsSync(localEmbeddingsPaths(baseDir).metaPath), false);
  });

  test("pull reports an error → 'pull-failed' with Ollama's reason", async () => {
    const baseDir = seed();
    const ollama = fakeOllama({ installed: [], pullLines: [{ status: "pulling manifest" }, { error: "pull model manifest: file does not exist" }] });
    const { d } = deps(baseDir, ollama.fetchFn);

    assert.equal(await runLocalEmbedJob(d), false);
    const job = readLocalEmbeddingsJob(baseDir);
    assert.equal(job.errorKind, "pull-failed");
    assert.match(job.lastError!, /Couldn't download the local search model \(nomic-embed-text\).*file does not exist.*Retry/);
  });

  test("a pull stream that ends without 'success' is a failure, not a silent half-download", async () => {
    const baseDir = seed();
    const { d } = deps(baseDir, fakeOllama({ installed: [], pullLines: [{ status: "pulling abc", total: 10, completed: 3 }] }).fetchFn);
    assert.equal(await runLocalEmbedJob(d), false);
    assert.equal(readLocalEmbeddingsJob(baseDir).errorKind, "pull-failed");
  });

  test("embedding keeps failing → retried once, then 'embed-failed'; a previous index is left exactly as it was", async () => {
    const baseDir = seed();
    const p = localEmbeddingsPaths(baseDir);
    mkdirSync(p.dir, { recursive: true });
    const previousOpps = JSON.stringify([{ id: "old", embedding: [9, 9, 9, 9] }]);
    const previousMeta = JSON.stringify({ complete: true, embeddingModel: "nomic-embed-text", dims: 4, count: 1, embeddedAt: "2026-09-01" });
    writeFileSync(p.oppsPath, previousOpps);
    writeFileSync(p.metaPath, previousMeta);

    const ollama = fakeOllama({ installed: ["nomic-embed-text:latest"], embedFail: () => 400 });
    const { d } = deps(baseDir, ollama.fetchFn);

    assert.equal(await runLocalEmbedJob(d), false);
    assert.equal(ollama.embedCalls, 2, "embedWithRetry: one retry of the run");
    const job = readLocalEmbeddingsJob(baseDir);
    assert.equal(job.errorKind, "embed-failed");
    assert.match(job.lastError!, /Building the local search index failed.*model crashed.*Retry; your current search setup is unchanged/);
    assert.equal(readFileSync(p.oppsPath, "utf8"), previousOpps);
    assert.equal(readFileSync(p.metaPath, "utf8"), previousMeta);
  });

  test("a transient failure on the first run succeeds on the retry", async () => {
    const baseDir = seed();
    const ollama = fakeOllama({ installed: ["nomic-embed-text:latest"], embedFail: (n) => (n === 1 ? 400 : undefined) });
    const { d } = deps(baseDir, ollama.fetchFn);
    assert.equal(await runLocalEmbedJob(d), true);
    assert.equal(readLocalEmbeddingsJob(baseDir).lastError, undefined);
  });

  test("an update re-embeds only new/changed grants, reusing the previous local vectors", async () => {
    const baseDir = seed();
    const ollama1 = fakeOllama({ installed: ["nomic-embed-text:latest"] });
    assert.equal(await runLocalEmbedJob(deps(baseDir, ollama1.fetchFn).d), true);

    // data:refresh changed one record and added one.
    const refreshed = [...HOSTED_OPPS.slice(0, 4), { ...HOSTED_OPPS[4], description: "changed" }, { id: "g6", program: "P6", agency: "A", description: "D" }];
    mkdirSync(join(baseDir, "data", "local"), { recursive: true });
    writeFileSync(join(baseDir, "data", "local", "opportunities.json"), JSON.stringify(refreshed));
    writeFileSync(join(baseDir, "data", "local", "corpus-meta.json"), JSON.stringify({ builtAt: "2026-10-01T00:00:00.000Z", count: 6 }));

    const ollama2 = fakeOllama({ installed: ["nomic-embed-text:latest"] });
    const { d, jobs } = deps(baseDir, ollama2.fetchFn);
    assert.equal(await runLocalEmbedJob(d), true);
    assert.deepEqual(ollama2.embeddedInputs, ["P5. A. changed", "P6. A. D"]);
    assert.deepEqual(jobs.find((j) => j.stage === "embedding"), { startedAt: "2026-10-04T12:00:00.000Z", finishedAt: "2026-10-04T12:00:00.000Z", stage: "embedding", done: 4, total: 6, pct: 67 });
    const meta = readJson(localEmbeddingsPaths(baseDir).metaPath);
    assert.equal(meta.count, 6);
    assert.equal(meta.reused, 4);
    assert.equal(meta.sourceBuiltAt, "2026-10-01T00:00:00.000Z");
  });

  test("an empty or missing corpus fails clearly", async () => {
    const baseDir = seed();
    writeFileSync(join(baseDir, "data", "opportunities.json"), "[]");
    const { d } = deps(baseDir, fakeOllama({ installed: ["nomic-embed-text:latest"] }).fetchFn);
    assert.equal(await runLocalEmbedJob(d), false);
    assert.match(readLocalEmbeddingsJob(baseDir).lastError!, /missing or empty/);
  });
});

describe("helpers", () => {
  test("hasModel treats a bare tag as :latest", () => {
    assert.equal(hasModel(["nomic-embed-text:latest"], "nomic-embed-text"), true);
    assert.equal(hasModel(["nomic-embed-text:v1.5"], "nomic-embed-text"), false);
    assert.equal(hasModel(["nomic-embed-text:v1.5"], "nomic-embed-text:v1.5"), true);
    assert.equal(hasModel([], "nomic-embed-text"), false);
  });

  test("pullLinePct", () => {
    assert.equal(pullLinePct({ total: 200, completed: 50 }), 25);
    assert.equal(pullLinePct({}), undefined);
    assert.equal(pullLinePct({ total: 0, completed: 0 }), undefined);
  });
});

/** A fetch that answers /api/tags normally but stalls the given path(s) until aborted. */
function stallingOllama(opts: { stallPull?: boolean; stallEmbedAfter?: number; installed?: string[] }) {
  let embedCalls = 0;
  const fetchFn = (async (url: string, init?: { body?: string; signal?: AbortSignal }) => {
    const path = url.replace(/^http:\/\/ollama\.test/, "");
    const hang = () =>
      new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      });
    if (path === "/api/tags") return new Response(JSON.stringify({ models: (opts.installed ?? []).map((name) => ({ name })) }));
    if (path === "/api/pull" && opts.stallPull) {
      // Headers + one progress line arrive, then Ollama goes silent forever.
      const enc = new TextEncoder();
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(enc.encode(JSON.stringify({ status: "pulling x", total: 100, completed: 10 }) + "\n"));
        },
      });
      return new Response(body);
    }
    if (path === "/v1/embeddings") {
      const body = JSON.parse(init!.body!);
      if (body.input === "warmup") return new Response(JSON.stringify({ data: [{ embedding: [0] }] }));
      embedCalls++;
      if (opts.stallEmbedAfter != null && embedCalls > opts.stallEmbedAfter) return hang();
      return new Response(JSON.stringify({ data: body.input.map((_: string, i: number) => ({ index: i, embedding: Array(DIMS).fill(0.5) })) }));
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
  return { fetchFn, get embedCalls() { return embedCalls; } };
}

describe("runLocalEmbedJob — a stalled Ollama ends in a Retry-able timeout, never 'running' forever", () => {
  test("pull stream goes silent → 'timeout' after the idle window", { timeout: 10_000 }, async () => {
    const baseDir = seed();
    const { d } = deps(baseDir, stallingOllama({ stallPull: true }).fetchFn, { pullIdleTimeoutMs: 150 });
    const t0 = Date.now();
    assert.equal(await runLocalEmbedJob(d), false);
    assert.ok(Date.now() - t0 < 5000);
    const job = readLocalEmbeddingsJob(baseDir);
    assert.equal(job.errorKind, "timeout");
    assert.match(job.lastError!, /Ollama stopped responding while downloading the local search model.*Click Retry/);
  });

  test("an embedding request that never answers → 'timeout' (after the one retry), nothing written", { timeout: 10_000 }, async () => {
    const baseDir = seed();
    const ollama = stallingOllama({ installed: ["nomic-embed-text:latest"], stallEmbedAfter: 1 });
    const { d } = deps(baseDir, ollama.fetchFn, { embedRequestTimeoutMs: 100 });
    assert.equal(await runLocalEmbedJob(d), false);
    const job = readLocalEmbeddingsJob(baseDir);
    assert.equal(job.errorKind, "timeout");
    assert.match(job.lastError!, /Ollama stopped responding while building the local search index.*click Retry/i);
    assert.equal(existsSync(localEmbeddingsPaths(baseDir).metaPath), false);
  });
});

describe("runLocalEmbedJob — the retry resumes instead of starting over", () => {
  test("a failure mid-run: the retry only embeds what's left, and progress never goes backwards", async () => {
    const baseDir = seed();
    // 5 grants, batch 2: call 1 ok (g1,g2), call 2 fails, then the retry must embed only g3..g5.
    const ollama = fakeOllama({ installed: ["nomic-embed-text:latest"], embedFail: (n) => (n === 2 ? 400 : undefined) });
    const { d, jobs } = deps(baseDir, ollama.fetchFn);
    assert.equal(await runLocalEmbedJob(d), true);
    assert.deepEqual(ollama.embeddedInputs, ["P1. A. D", "P2. A. D", "P3. A. D", "P4. A. D", "P5. A. D"], "each grant embedded once");
    const done = jobs.filter((j) => j.stage === "embedding").map((j) => j.done!);
    assert.deepEqual(done, [...done].sort((a, b) => a - b), `monotonic: ${done.join(",")}`);
    assert.equal(done.at(-1), 5);
    const out = JSON.parse(readFileSync(localEmbeddingsPaths(baseDir).oppsPath, "utf8"));
    assert.ok(out.every((o: { embedding: number[] }) => o.embedding.length === DIMS));
  });
});

describe("runLocalEmbedJob — only sets up Ollama", () => {
  test("LLM_PROVIDER=openai/local (not Ollama) → fails fast with the manual-setup message, no Ollama calls", async () => {
    const baseDir = seed();
    const ollama = fakeOllama({ installed: ["nomic-embed-text:latest"] });
    const { d } = deps(baseDir, ollama.fetchFn, { ollamaBackend: false });
    assert.equal(await runLocalEmbedJob(d), false);
    assert.deepEqual(ollama.log, []);
    const job = readLocalEmbeddingsJob(baseDir);
    assert.equal(job.errorKind, "not-ollama");
    assert.match(job.lastError!, /isn't Ollama.*EMBEDDINGS_BASE_URL.*data:embed:local/);
  });

  test("a server that answers but has no /api/tags (LM Studio) → 'not-ollama', not a misleading 'couldn't reach Ollama'", async () => {
    const baseDir = seed();
    const lmStudio = (async () => new Response("Unexpected endpoint", { status: 404 })) as unknown as typeof fetch;
    const { d } = deps(baseDir, lmStudio);
    assert.equal(await runLocalEmbedJob(d), false);
    const job = readLocalEmbeddingsJob(baseDir);
    assert.equal(job.errorKind, "not-ollama");
    assert.doesNotMatch(job.lastError!, /Couldn't reach Ollama/);
  });
});
