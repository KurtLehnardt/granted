import { describe, test, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CorpusStore } from "../../lib/corpus/store";
import { activeEmbeddingTarget, assertEmbeddingDimsMatch, embed } from "../../lib/embed";
import { buildLocalEmbeddingsStatus, localEmbeddingsActive, localEmbeddingsPaths } from "../../lib/embeddings/localEmbeddings";
import { resetLlmConfigCache } from "../../lib/llm/config";

/**
 * End to end, minus the browser: the real scripts/local-embeddings-job.mjs
 * process (what Settings → Local spawns) against a fake Ollama HTTP server, then
 * the real CorpusStore + embed() switching over to the index it built — and back
 * to hosted on Cloud. Hermetic: loopback fake server, temp dirs, no keys.
 */

const SCRIPT = fileURLToPath(new URL("../local-embeddings-job.mjs", import.meta.url));
const TSX = import.meta.resolve("tsx");
const DIMS = 6;

type Fake = { server: Server; url: string; log: string[] };

async function fakeOllama({ installed = [] as string[] } = {}): Promise<Fake> {
  const log: string[] = [];
  const models = [...installed];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      log.push(`${req.method} ${req.url}`);
      if (req.url === "/api/tags") {
        res.setHeader("content-type", "application/json");
        return res.end(JSON.stringify({ models: models.map((name) => ({ name })) }));
      }
      if (req.url === "/api/pull") {
        res.setHeader("content-type", "application/x-ndjson");
        res.write(JSON.stringify({ status: "pulling manifest" }) + "\n");
        res.write(JSON.stringify({ status: "pulling x", total: 100, completed: 50 }) + "\n");
        models.push("nomic-embed-text:latest");
        return res.end(JSON.stringify({ status: "success" }) + "\n");
      }
      if (req.url === "/v1/embeddings") {
        const { input, model } = JSON.parse(body);
        if (model !== "nomic-embed-text") {
          res.statusCode = 404;
          return res.end("unknown model");
        }
        const inputs = Array.isArray(input) ? input : [input];
        res.setHeader("content-type", "application/json");
        return res.end(JSON.stringify({ data: inputs.map((_: string, index: number) => ({ index, embedding: Array(DIMS).fill(0.25) })) }));
      }
      res.statusCode = 404;
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as { port: number };
  return { server, url: `http://127.0.0.1:${port}`, log };
}

function seedCorpus() {
  const baseDir = mkdtempSync(join(tmpdir(), "granted-local-job-it-"));
  mkdirSync(join(baseDir, "data"), { recursive: true });
  const opps = [1, 2, 3].map((i) => ({ id: `g${i}`, program: `P${i}`, agency: "A", description: "D", embedding: [0.1, 0.2] }));
  writeFileSync(join(baseDir, "data", "opportunities.json"), JSON.stringify(opps));
  writeFileSync(join(baseDir, "data", "corpus-meta.json"), JSON.stringify({ builtAt: "2026-09-01T00:00:00.000Z", count: 3 }));
  return baseDir;
}

function runJob(baseDir: string, llmBaseUrl: string) {
  return new Promise<{ code: number | null; out: string }>((resolve) => {
    const env: NodeJS.ProcessEnv = { ...process.env, LLM_BASE_URL: llmBaseUrl };
    delete env.NODE_TEST_CONTEXT;
    delete env.GRANTED_LOCAL_EMBEDDINGS_LOCK_HELD;
    const child = spawn(process.execPath, ["--import", TSX, SCRIPT], { cwd: baseDir, env });
    let out = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (out += c));
    child.on("close", (code) => resolve({ code, out }));
  });
}

const cleanup: Array<() => void> = [];
const savedEnv = { ...process.env };
afterEach(() => {
  for (const k of ["GRANTED_LLM_CONFIG_PATH", "GRANTED_LOCAL_EMBEDDINGS_BASE_DIR", "LLM_BASE_URL", "EMBEDDINGS_BASE_URL"]) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  resetLlmConfigCache();
});
after(() => cleanup.forEach((f) => f()));

function useProvider(baseDir: string, provider: "ollama" | "cloud") {
  writeFileSync(join(baseDir, "llm-config.json"), JSON.stringify({ provider }));
  process.env.GRANTED_LLM_CONFIG_PATH = join(baseDir, "llm-config.json");
  process.env.GRANTED_LOCAL_EMBEDDINGS_BASE_DIR = baseDir;
  resetLlmConfigCache();
}

describe("Settings → Local: background job → local search, end to end (fake Ollama)", () => {
  test("pulls the model, builds the index, then search switches to it on Local and back to hosted on Cloud", { timeout: 60_000 }, async () => {
    const ollama = await fakeOllama({ installed: ["llama3.2:1b"] });
    const baseDir = seedCorpus();
    cleanup.push(() => ollama.server.close(), () => rmSync(baseDir, { recursive: true, force: true }));

    delete process.env.EMBEDDINGS_BASE_URL;
    useProvider(baseDir, "ollama");
    assert.equal(buildLocalEmbeddingsStatus(baseDir).state, "needed");

    const { code, out } = await runJob(baseDir, ollama.url);
    assert.equal(code, 0, out);
    assert.ok(ollama.log.includes("POST /api/pull"), "pulled the missing model");

    const p = localEmbeddingsPaths(baseDir);
    assert.equal(existsSync(p.lockPath), false, "lock released");
    const meta = JSON.parse(readFileSync(p.metaPath, "utf8"));
    assert.equal(meta.complete, true);
    assert.equal(meta.dims, DIMS);
    const job = JSON.parse(readFileSync(p.jobPath, "utf8"));
    assert.ok(job.finishedAt);
    assert.equal(job.lastError, undefined);

    // Local: the store serves the index and queries embed with the same model → dims match.
    process.env.LLM_BASE_URL = ollama.url;
    const status = buildLocalEmbeddingsStatus(baseDir);
    assert.equal(status.state, "ready");
    assert.equal(status.active, true);
    assert.equal(localEmbeddingsActive(baseDir), true);
    const store = new CorpusStore(baseDir, { localIndexDir: () => (localEmbeddingsActive(baseDir) ? localEmbeddingsPaths(baseDir).dir : null) });
    const corpus = store.load();
    assert.equal(corpus.source, "local-embeddings");
    const q = await embed("rural clinics");
    assert.equal(q.length, DIMS);
    assert.doesNotThrow(() => assertEmbeddingDimsMatch(q.length, corpus.opportunities[0].embedding?.length));

    // Cloud: hosted corpus and hosted (OpenAI) query embeddings again, index untouched for next time.
    useProvider(baseDir, "cloud");
    assert.equal(store.load().source, "committed");
    assert.equal(store.load().opportunities[0].embedding?.length, 2);
    assert.equal(activeEmbeddingTarget().source, "env");
    assert.equal(existsSync(p.metaPath), true);
  });

  test("Ollama not running → the job exits non-zero and Settings shows a plain 'failed' status with nothing switched", { timeout: 60_000 }, async () => {
    const ollama = await fakeOllama();
    const deadUrl = ollama.url;
    await new Promise((r) => ollama.server.close(r)); // nothing listening there now
    const baseDir = seedCorpus();
    cleanup.push(() => rmSync(baseDir, { recursive: true, force: true }));

    delete process.env.EMBEDDINGS_BASE_URL;
    useProvider(baseDir, "ollama");
    const { code } = await runJob(baseDir, deadUrl);
    assert.equal(code, 1);

    const status = buildLocalEmbeddingsStatus(baseDir);
    assert.equal(status.state, "failed");
    assert.equal(status.errorKind, "ollama-unreachable");
    assert.match(status.error!, /Couldn't reach Ollama/);
    assert.equal(status.active, false);
    assert.equal(new CorpusStore(baseDir, { localIndexDir: () => (localEmbeddingsActive(baseDir) ? localEmbeddingsPaths(baseDir).dir : null) }).load().source, "committed");
  });
});

describe("a job process that dies on startup is reported, not silently dropped (real spawn)", () => {
  test("startLocalEmbeddingsJob from a dir where the script can't load → 'crashed' with the child's own error, lock released", { timeout: 30_000 }, async () => {
    const { startLocalEmbeddingsJob } = await import("../../lib/embeddings/startLocalEmbeddings");
    const { readLocalEmbeddingsJob, isLocalEmbeddingsRunning } = await import("../../lib/embeddings/localEmbeddings");
    // No scripts/ and no node_modules here: like `next start` without devDependencies (tsx).
    const baseDir = mkdtempSync(join(tmpdir(), "granted-job-crash-"));
    cleanup.push(() => rmSync(baseDir, { recursive: true, force: true }));

    assert.deepEqual(startLocalEmbeddingsJob({ baseDir }), { started: true });
    const deadline = Date.now() + 20_000;
    while (!readLocalEmbeddingsJob(baseDir).lastError && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));

    const job = readLocalEmbeddingsJob(baseDir);
    assert.equal(job.errorKind, "crashed");
    assert.match(job.lastError!, /stopped unexpectedly \(exit code \d+\): .*(tsx|Cannot find|ERR_MODULE_NOT_FOUND).*Click Retry/);
    assert.equal(isLocalEmbeddingsRunning(baseDir), false);
    assert.match(readFileSync(localEmbeddingsPaths(baseDir).logPath, "utf8"), /tsx|Cannot find/);
  });
});
