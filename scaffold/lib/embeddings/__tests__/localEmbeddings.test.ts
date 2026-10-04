import { describe, test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LOCAL_EMBED_MODEL,
  acquireLocalEmbeddingsLock,
  buildLocalEmbeddingsStatus,
  deriveLocalEmbeddingsStatus,
  envEmbeddingsAreHosted,
  isLocalEmbeddingsRunning,
  isLocalIndexOutdated,
  isLocalIndexReady,
  localEmbeddingsActive,
  localEmbeddingsBaseDir,
  localEmbeddingsPaths,
  localOllamaUrls,
  readLocalEmbeddingsJob,
  readLocalIndexMeta,
  releaseLocalEmbeddingsLock,
  shouldAutoStart,
  shouldUseLocalIndex,
  sourceCorpusPaths,
  transferLocalEmbeddingsLock,
  writeLocalEmbeddingsJob,
  type LocalIndexMeta,
} from "../localEmbeddings";
import { resetLlmConfigCache } from "@/lib/llm/config";

const READY: LocalIndexMeta = {
  complete: true,
  embeddingModel: LOCAL_EMBED_MODEL,
  dims: 768,
  count: 10,
  sourceBuiltAt: "2026-09-01T00:00:00.000Z",
  sourceCount: 10,
  embeddedAt: "2026-09-02T00:00:00.000Z",
};

const dirs: string[] = [];
function tmpBase() {
  const d = mkdtempSync(join(tmpdir(), "granted-local-emb-"));
  dirs.push(d);
  return d;
}
function writeIndex(baseDir: string, meta: LocalIndexMeta) {
  const p = localEmbeddingsPaths(baseDir);
  mkdirSync(p.dir, { recursive: true });
  writeFileSync(p.oppsPath, JSON.stringify([{ id: "a", embedding: [1, 2] }]));
  writeFileSync(p.metaPath, JSON.stringify(meta));
}

const savedEnv = { ...process.env };
afterEach(() => {
  for (const k of ["GRANTED_LLM_CONFIG_PATH", "GRANTED_LOCAL_EMBEDDINGS_BASE_DIR", "LLM_PROVIDER", "EMBEDDINGS_BASE_URL", "LLM_BASE_URL"]) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  resetLlmConfigCache();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("readiness, staleness and when the local index is used (pure)", () => {
  test("ready only for a complete index of the expected model with real dims and records", () => {
    assert.equal(isLocalIndexReady(READY), true);
    assert.equal(isLocalIndexReady(null), false);
    assert.equal(isLocalIndexReady({ ...READY, complete: false }), false);
    assert.equal(isLocalIndexReady({ ...READY, embeddingModel: "text-embedding-3-small" }), false);
    assert.equal(isLocalIndexReady({ ...READY, dims: 0 }), false);
    assert.equal(isLocalIndexReady({ ...READY, count: 0 }), false);
  });

  test("outdated when the hosted corpus' builtAt or count moved on", () => {
    assert.equal(isLocalIndexOutdated(READY, { builtAt: "2026-09-01T00:00:00.000Z", count: 10 }), false);
    assert.equal(isLocalIndexOutdated(READY, { builtAt: "2026-10-01T00:00:00.000Z", count: 10 }), true);
    assert.equal(isLocalIndexOutdated(READY, { builtAt: "2026-09-01T00:00:00.000Z", count: 11 }), true);
    assert.equal(isLocalIndexOutdated(READY, null), false);
  });

  test("the local index is used only for Local + app-managed embeddings + a ready index", () => {
    assert.equal(shouldUseLocalIndex({ provider: "ollama", envIsHosted: true, ready: true }), true);
    assert.equal(shouldUseLocalIndex({ provider: "cloud", envIsHosted: true, ready: true }), false, "Cloud restores hosted embeddings");
    assert.equal(shouldUseLocalIndex({ provider: "ollama", envIsHosted: false, ready: true }), false, ".env.local wins");
    assert.equal(shouldUseLocalIndex({ provider: "ollama", envIsHosted: true, ready: false }), false, "never before it's complete");
  });

  test("envEmbeddingsAreHosted: unset/OpenAI → true; a local EMBEDDINGS_BASE_URL → false", () => {
    assert.equal(envEmbeddingsAreHosted(undefined), true);
    assert.equal(envEmbeddingsAreHosted("https://api.openai.com/v1"), true);
    assert.equal(envEmbeddingsAreHosted("http://localhost:11434/v1"), false);
  });

  test("localOllamaUrls follows LLM_BASE_URL (bare host or /v1) and defaults to localhost:11434", () => {
    assert.deepEqual(localOllamaUrls(undefined), { openAiBaseUrl: "http://localhost:11434/v1", nativeBaseUrl: "http://localhost:11434" });
    assert.deepEqual(localOllamaUrls("http://gpu-box:11434"), { openAiBaseUrl: "http://gpu-box:11434/v1", nativeBaseUrl: "http://gpu-box:11434" });
    assert.deepEqual(localOllamaUrls("http://gpu-box:11434/v1/"), { openAiBaseUrl: "http://gpu-box:11434/v1", nativeBaseUrl: "http://gpu-box:11434" });
  });
});

describe("deriveLocalEmbeddingsStatus (pure)", () => {
  const base = { provider: "ollama" as const, envIsHosted: true, meta: null, sourceMeta: null, running: false, job: {} };

  test("embeddings set in .env.local → not-applicable (the app leaves them alone)", () => {
    assert.equal(deriveLocalEmbeddingsStatus({ ...base, envIsHosted: false, meta: READY }).state, "not-applicable");
  });

  test("nothing built, nothing tried → needed", () => {
    const s = deriveLocalEmbeddingsStatus(base);
    assert.equal(s.state, "needed");
    assert.equal(s.active, false);
    assert.equal(s.model, "nomic-embed-text");
  });

  test("running → progress from the job file; the index isn't active until it's done", () => {
    const s = deriveLocalEmbeddingsStatus({ ...base, running: true, job: { stage: "embedding", done: 64, total: 4698, pct: 1 } });
    assert.equal(s.state, "running");
    assert.deepEqual(s.progress, { stage: "embedding", done: 64, total: 4698, pct: 1 });
    assert.equal(s.active, false);
  });

  test("an update running over a ready index keeps that index active", () => {
    const s = deriveLocalEmbeddingsStatus({ ...base, meta: READY, running: true, job: { stage: "checking" } });
    assert.equal(s.state, "running");
    assert.equal(s.active, true);
  });

  test("failed → the plain-language error and its kind", () => {
    const s = deriveLocalEmbeddingsStatus({
      ...base,
      job: { lastError: "Couldn't reach Ollama", errorKind: "ollama-unreachable", lastFailedAt: "2026-09-03T00:00:00.000Z" },
    });
    assert.equal(s.state, "failed");
    assert.equal(s.error, "Couldn't reach Ollama");
    assert.equal(s.errorKind, "ollama-unreachable");
  });

  test("ready (and active on Local, inactive on Cloud)", () => {
    const local = deriveLocalEmbeddingsStatus({ ...base, meta: READY, sourceMeta: { builtAt: READY.sourceBuiltAt, count: 10 } });
    assert.equal(local.state, "ready");
    assert.equal(local.active, true);
    assert.equal(local.outdated, false);
    assert.equal(local.count, 10);
    const cloud = deriveLocalEmbeddingsStatus({ ...base, provider: "cloud", meta: READY });
    assert.equal(cloud.state, "ready");
    assert.equal(cloud.active, false);
  });

  test("an old failure doesn't hide a newer finished index; a newer failure (of an update) is shown", () => {
    const old = deriveLocalEmbeddingsStatus({ ...base, meta: READY, job: { lastError: "x", lastFailedAt: "2026-09-01T00:00:00.000Z" } });
    assert.equal(old.state, "ready");
    const newer = deriveLocalEmbeddingsStatus({ ...base, meta: READY, job: { lastError: "x", lastFailedAt: "2026-09-05T00:00:00.000Z" } });
    assert.equal(newer.state, "failed");
    assert.equal(newer.active, true, "the existing index keeps serving searches");
  });

  test("shouldAutoStart: only on Local, and only when there's work (needed, failed, outdated)", () => {
    const needed = deriveLocalEmbeddingsStatus(base);
    assert.equal(shouldAutoStart(needed, "ollama"), true);
    assert.equal(shouldAutoStart(needed, "cloud"), false);
    const ready = deriveLocalEmbeddingsStatus({ ...base, meta: READY, sourceMeta: { builtAt: READY.sourceBuiltAt, count: 10 } });
    assert.equal(shouldAutoStart(ready, "ollama"), false);
    const outdated = deriveLocalEmbeddingsStatus({ ...base, meta: READY, sourceMeta: { builtAt: "2026-12-01T00:00:00.000Z" } });
    assert.equal(shouldAutoStart(outdated, "ollama"), true);
    assert.equal(shouldAutoStart(deriveLocalEmbeddingsStatus({ ...base, running: true }), "ollama"), false);
    assert.equal(shouldAutoStart(deriveLocalEmbeddingsStatus({ ...base, envIsHosted: false }), "ollama"), false);
  });
});

describe("on-disk state: job file, lock, meta cache", () => {
  test("under node:test the default base dir never points at the real checkout", () => {
    delete process.env.GRANTED_LOCAL_EMBEDDINGS_BASE_DIR;
    assert.notEqual(localEmbeddingsBaseDir(), process.cwd());
    process.env.GRANTED_LOCAL_EMBEDDINGS_BASE_DIR = "/some/dir";
    assert.equal(localEmbeddingsBaseDir(), "/some/dir");
  });

  test("job file round-trips; absent → {}", () => {
    const b = tmpBase();
    assert.deepEqual(readLocalEmbeddingsJob(b), {});
    writeLocalEmbeddingsJob({ stage: "pulling", pct: 40 }, b);
    assert.deepEqual(readLocalEmbeddingsJob(b), { stage: "pulling", pct: 40 });
  });

  test("lock is single-flight, transferable, and a dead owner's lock is reclaimed", () => {
    const b = tmpBase();
    assert.equal(acquireLocalEmbeddingsLock(b), true);
    assert.equal(isLocalEmbeddingsRunning(b), true);
    assert.equal(acquireLocalEmbeddingsLock(b), false);
    transferLocalEmbeddingsLock(2 ** 30, b); // a pid that isn't alive
    assert.equal(isLocalEmbeddingsRunning(b), false);
    assert.equal(existsSync(localEmbeddingsPaths(b).lockPath), false);
    assert.equal(acquireLocalEmbeddingsLock(b), true);
    releaseLocalEmbeddingsLock(b);
    assert.equal(isLocalEmbeddingsRunning(b), false);
  });

  test("readLocalIndexMeta picks up a rewritten meta (mtime cache) and returns null once it's gone", () => {
    const b = tmpBase();
    assert.equal(readLocalIndexMeta(b), null);
    writeIndex(b, { ...READY, count: 1 });
    assert.equal(readLocalIndexMeta(b)?.count, 1);
    const later = new Date(Date.now() + 5000);
    writeFileSync(localEmbeddingsPaths(b).metaPath, JSON.stringify({ ...READY, count: 2 }));
    utimesSync(localEmbeddingsPaths(b).metaPath, later, later);
    assert.equal(readLocalIndexMeta(b)?.count, 2);
    rmSync(localEmbeddingsPaths(b).metaPath);
    assert.equal(readLocalIndexMeta(b), null);
  });

  test("sourceCorpusPaths: a data:refresh copy wins over the committed snapshot", () => {
    const b = tmpBase();
    assert.equal(sourceCorpusPaths(b).dir, join(b, "data"));
    mkdirSync(join(b, "data", "local"), { recursive: true });
    writeFileSync(join(b, "data", "local", "opportunities.json"), "[]");
    assert.equal(sourceCorpusPaths(b).dir, join(b, "data", "local"));
  });
});

describe("localEmbeddingsActive / buildLocalEmbeddingsStatus (real config file + env)", () => {
  function useConfig(b: string, provider: "ollama" | "cloud") {
    const p = join(b, "llm-config.json");
    writeFileSync(p, JSON.stringify({ provider }));
    process.env.GRANTED_LLM_CONFIG_PATH = p;
    resetLlmConfigCache();
  }

  test("Local + ready index → active; switching back to Cloud → inactive (hosted restored, index kept)", () => {
    const b = tmpBase();
    delete process.env.EMBEDDINGS_BASE_URL;
    writeIndex(b, READY);
    useConfig(b, "ollama");
    assert.equal(localEmbeddingsActive(b), true);
    useConfig(b, "cloud");
    assert.equal(localEmbeddingsActive(b), false);
    assert.equal(existsSync(localEmbeddingsPaths(b).oppsPath), true, "the index stays for the next switch to Local");
  });

  test("an EMBEDDINGS_BASE_URL in .env.local always wins", () => {
    const b = tmpBase();
    process.env.EMBEDDINGS_BASE_URL = "http://localhost:11434/v1";
    writeIndex(b, READY);
    useConfig(b, "ollama");
    assert.equal(localEmbeddingsActive(b), false);
    assert.equal(buildLocalEmbeddingsStatus(b).state, "not-applicable");
  });

  test("buildLocalEmbeddingsStatus reads the job, lock and source corpus from disk", () => {
    const b = tmpBase();
    delete process.env.EMBEDDINGS_BASE_URL;
    useConfig(b, "ollama");
    mkdirSync(join(b, "data"), { recursive: true });
    writeFileSync(join(b, "data", "corpus-meta.json"), JSON.stringify({ builtAt: "2026-12-01T00:00:00.000Z", count: 10 }));
    assert.equal(buildLocalEmbeddingsStatus(b).state, "needed");
    writeIndex(b, READY);
    const s = buildLocalEmbeddingsStatus(b);
    assert.equal(s.state, "ready");
    assert.equal(s.outdated, true);
    acquireLocalEmbeddingsLock(b);
    writeLocalEmbeddingsJob({ stage: "embedding", done: 5, total: 10, pct: 50 }, b);
    assert.equal(buildLocalEmbeddingsStatus(b).state, "running");
    releaseLocalEmbeddingsLock(b);
  });
});
