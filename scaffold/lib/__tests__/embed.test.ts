import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  embed,
  embedBatch,
  checkEmbeddingsMisconfig,
  assertEmbeddingDimsMatch,
  activeEmbeddingTarget,
  envEmbeddingTarget,
} from "../embed";
import { resetLlmConfigCache } from "../llm/config";

/**
 * The preflight guard added after a real self-hoster set LLM_PROVIDER=local
 * (so the LLM correctly went local) but never moved the SEPARATE embeddings
 * seam off its OpenAI default — lib/embed.ts then called OpenAI with the
 * .env.example placeholder key and surfaced only a cryptic "Embedding
 * request failed (401): Incorrect API key". These tests lock in the clear,
 * actionable failure instead.
 *
 * embed.ts's BASE_URL/IS_OPENAI are read ONCE at module load from
 * EMBEDDINGS_BASE_URL, which makes re-importing the module per test env
 * awkward under the tsx --test runner. So the actual decision lives in the
 * exported pure function `checkEmbeddingsMisconfig(isOpenAiTarget, isLocal,
 * key)` — tested directly below — and a second block exercises the real
 * embed()/embedBatch() to confirm the guard is actually wired in at the top
 * of both (this file never sets EMBEDDINGS_BASE_URL, so IS_OPENAI is true
 * for every test here, matching a default/cloud-embeddings install).
 */

const savedProvider = process.env.LLM_PROVIDER;
const savedOpenAiKey = process.env.OPENAI_API_KEY;
const savedEmbedKey = process.env.EMBEDDINGS_API_KEY;
const realFetch = globalThis.fetch;

afterEach(() => {
  if (savedProvider === undefined) delete process.env.LLM_PROVIDER;
  else process.env.LLM_PROVIDER = savedProvider;
  if (savedOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = savedOpenAiKey;
  if (savedEmbedKey === undefined) delete process.env.EMBEDDINGS_API_KEY;
  else process.env.EMBEDDINGS_API_KEY = savedEmbedKey;
  globalThis.fetch = realFetch;
});

describe("checkEmbeddingsMisconfig — pure guard logic", () => {
  test("no-op once embeddings already target a non-OpenAI endpoint (IS_OPENAI false), regardless of local LLM or key", () => {
    assert.doesNotThrow(() => checkEmbeddingsMisconfig(false, true, undefined));
    assert.doesNotThrow(() => checkEmbeddingsMisconfig(false, false, "sk-..."));
  });

  test("local LLM configured but embeddings still target OpenAI → names the concrete fix", () => {
    assert.throws(
      () => checkEmbeddingsMisconfig(true, true, undefined),
      /Local LLM is set \(Settings or LLM_PROVIDER\) but embeddings still target OpenAI/,
    );
    try {
      checkEmbeddingsMisconfig(true, true, "sk-real-key-doesnt-matter-here");
      assert.fail("expected checkEmbeddingsMisconfig to throw");
    } catch (err) {
      const message = (err as Error).message;
      assert.match(message, /EMBEDDINGS_BASE_URL=http:\/\/localhost:11434\/v1/);
      assert.match(message, /EMBEDDINGS_MODEL=nomic-embed-text/);
      assert.match(message, /ollama pull nomic-embed-text/);
      assert.match(message, /npm run data:embed/);
      assert.match(message, /Fully offline/);
    }
  });

  test("the local-LLM branch takes precedence over an otherwise-fine key", () => {
    assert.throws(
      () => checkEmbeddingsMisconfig(true, true, "sk-proj-abcdefghijklmnopqrstuvwxyz"),
      /Local LLM is set/,
    );
  });

  for (const bad of [undefined, "", "sk-...", "sk-ant-...", "sk-short"]) {
    test(`placeholder/missing key (${JSON.stringify(bad)}) throws the clear message, when not local`, () => {
      assert.throws(
        () => checkEmbeddingsMisconfig(true, false, bad),
        /OPENAI_API_KEY is missing or still the \.env\.example placeholder/,
      );
    });
  }

  test("a plausible real key does not throw", () => {
    assert.doesNotThrow(() =>
      checkEmbeddingsMisconfig(true, false, "sk-proj-abcdefghijklmnopqrstuvwxyz1234567890"),
    );
    assert.doesNotThrow(() =>
      checkEmbeddingsMisconfig(true, false, "sk-ant-abcdefghijklmnopqrstuvwxyz1234567890"),
    );
  });
});

describe("embed()/embedBatch() — the guard fires before any network call", () => {
  test("embed(): LLM_PROVIDER=ollama with no EMBEDDINGS_BASE_URL throws the local-LLM message, never touches fetch", async () => {
    process.env.LLM_PROVIDER = "ollama";
    delete process.env.OPENAI_API_KEY;
    let fetchCalled = false;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      return { ok: true, json: async () => ({ data: [{ embedding: [0] }], usage: {} }) };
    }) as unknown as typeof fetch;

    await assert.rejects(
      () => embed("hello"),
      /Local LLM is set \(Settings or LLM_PROVIDER\) but embeddings still target OpenAI/,
    );
    assert.equal(fetchCalled, false);
  });

  test("embedBatch(): same misconfiguration throws before any network call", async () => {
    process.env.LLM_PROVIDER = "ollama";
    delete process.env.OPENAI_API_KEY;
    let fetchCalled = false;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      return { ok: true, json: async () => ({ data: [], usage: {} }) };
    }) as unknown as typeof fetch;

    await assert.rejects(
      () => embedBatch(["hello"]),
      /Local LLM is set \(Settings or LLM_PROVIDER\) but embeddings still target OpenAI/,
    );
    assert.equal(fetchCalled, false);
  });

  test("embed(): no local LLM + placeholder key throws before any network call", async () => {
    delete process.env.LLM_PROVIDER;
    process.env.OPENAI_API_KEY = "sk-...";
    let fetchCalled = false;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      return { ok: true, json: async () => ({ data: [{ embedding: [0] }], usage: {} }) };
    }) as unknown as typeof fetch;

    await assert.rejects(
      () => embed("hello"),
      /OPENAI_API_KEY is missing or still the \.env\.example placeholder/,
    );
    assert.equal(fetchCalled, false);
  });

  test("embed(): a plausible real key clears the guard and reaches the network", async () => {
    delete process.env.LLM_PROVIDER;
    process.env.OPENAI_API_KEY = "sk-proj-abcdefghijklmnopqrstuvwxyz1234567890";
    globalThis.fetch = (async () => ({
      ok: true,
      json: async () => ({ data: [{ embedding: [1, 2, 3] }], usage: { prompt_tokens: 3 } }),
    })) as unknown as typeof fetch;

    const vec = await embed("hello");
    assert.deepEqual(vec, [1, 2, 3]);
  });
});

/**
 * The dimension-mismatch guard: switching EMBEDDINGS_MODEL without re-embedding
 * the corpus makes cosine() read past the shorter vector and return NaN for
 * every opp — a silent, confusing "weak field". This locks in the loud,
 * actionable failure (and the no-ops that must NOT fire).
 */
describe("assertEmbeddingDimsMatch — corpus/query embedding-space guard", () => {
  test("matching dimensions is a no-op", () => {
    assert.doesNotThrow(() => assertEmbeddingDimsMatch(512, 512));
  });

  test("mismatch throws with both dims and the `data:embed` fix", () => {
    assert.throws(
      () => assertEmbeddingDimsMatch(768, 512),
      (err: Error) =>
        /dimension mismatch/i.test(err.message) &&
        /768/.test(err.message) &&
        /512/.test(err.message) &&
        /data:embed/.test(err.message),
    );
  });

  test("null/0 corpus dimension is a no-op (un-embedded corpus handled elsewhere)", () => {
    assert.doesNotThrow(() => assertEmbeddingDimsMatch(768, null));
    assert.doesNotThrow(() => assertEmbeddingDimsMatch(768, undefined));
    assert.doesNotThrow(() => assertEmbeddingDimsMatch(768, 0));
  });
});

/**
 * Settings → Local's index (lib/embeddings): once it's complete and Local is
 * selected, query embeddings go to Ollama's nomic-embed-text; on Cloud (or with
 * EMBEDDINGS_* set in .env.local) they go where they always did.
 */
describe("activeEmbeddingTarget — Settings-built local index", () => {
  const savedPaths = {
    cfg: process.env.GRANTED_LLM_CONFIG_PATH,
    base: process.env.GRANTED_LOCAL_EMBEDDINGS_BASE_DIR,
    llmBase: process.env.LLM_BASE_URL,
  };
  let dir = "";

  function setup(provider: "ollama" | "cloud", ready: boolean) {
    dir = mkdtempSync(join(tmpdir(), "granted-embed-target-"));
    writeFileSync(join(dir, "llm-config.json"), JSON.stringify({ provider }));
    process.env.GRANTED_LLM_CONFIG_PATH = join(dir, "llm-config.json");
    process.env.GRANTED_LOCAL_EMBEDDINGS_BASE_DIR = dir;
    resetLlmConfigCache();
    if (ready) {
      const idx = join(dir, "data", "local", "local-embeddings");
      mkdirSync(idx, { recursive: true });
      writeFileSync(join(idx, "opportunities.json"), "[]");
      writeFileSync(
        join(idx, "corpus-meta.json"),
        JSON.stringify({ complete: true, embeddingModel: "nomic-embed-text", dims: 768, count: 4698 }),
      );
    }
  }

  function captureFetch() {
    const calls: Array<{ url: string; body: any; auth: string }> = [];
    globalThis.fetch = (async (url: string, init: { body: string; headers: Record<string, string> }) => {
      calls.push({ url, body: JSON.parse(init.body), auth: init.headers.Authorization });
      const input = JSON.parse(init.body).input;
      const n = Array.isArray(input) ? input.length : 1;
      return { ok: true, json: async () => ({ data: Array.from({ length: n }, (_, index) => ({ index, embedding: [1, 2, 3] })), usage: {} }) };
    }) as unknown as typeof fetch;
    return calls;
  }

  afterEach(() => {
    for (const [k, v] of [
      ["GRANTED_LLM_CONFIG_PATH", savedPaths.cfg],
      ["GRANTED_LOCAL_EMBEDDINGS_BASE_DIR", savedPaths.base],
      ["LLM_BASE_URL", savedPaths.llmBase],
    ] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    resetLlmConfigCache();
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = "";
  });

  test("Local + ready index → Ollama nomic-embed-text, no `dimensions`, never the OpenAI key", async () => {
    setup("ollama", true);
    process.env.OPENAI_API_KEY = "sk-proj-abcdefghijklmnopqrstuvwxyz1234567890";
    delete process.env.LLM_BASE_URL;
    assert.equal(activeEmbeddingTarget().source, "settings-local");
    const calls = captureFetch();
    await embed("rural clinic diagnostics");
    assert.equal(calls[0].url, "http://localhost:11434/v1/embeddings");
    assert.deepEqual(calls[0].body, { model: "nomic-embed-text", input: "rural clinic diagnostics" });
    assert.equal(calls[0].auth, "Bearer local");
  });

  test("follows LLM_BASE_URL (Ollama on another host) for the query embedder too", async () => {
    setup("ollama", true);
    process.env.LLM_BASE_URL = "http://gpu-box:11434";
    const calls = captureFetch();
    await embedBatch(["a", "b"]);
    assert.equal(calls[0].url, "http://gpu-box:11434/v1/embeddings");
  });

  test("Local but the index isn't finished → still the env target, so the clear 'not ready yet' guard fires (no OpenAI call)", async () => {
    setup("ollama", false);
    assert.equal(activeEmbeddingTarget().source, "env");
    const calls = captureFetch();
    await assert.rejects(() => embed("x"), /local search isn't ready yet[\s\S]*Settings → Model → Local sets it up/);
    assert.equal(calls.length, 0);
  });

  test("switching back to Cloud → hosted OpenAI embeddings again (512 dims), with the index left on disk", async () => {
    setup("cloud", true);
    process.env.OPENAI_API_KEY = "sk-proj-abcdefghijklmnopqrstuvwxyz1234567890";
    assert.equal(activeEmbeddingTarget().source, "env");
    const calls = captureFetch();
    await embed("x");
    assert.equal(calls[0].url, "https://api.openai.com/v1/embeddings");
    assert.equal(calls[0].body.dimensions, 512);
  });

  test("data:refresh on Local: the env-pinned target with allowHostedOnLocal embeds the hosted corpus (no 'Local LLM is set' throw)", async () => {
    setup("ollama", true);
    process.env.OPENAI_API_KEY = "sk-proj-abcdefghijklmnopqrstuvwxyz1234567890";
    const calls = captureFetch();
    const vecs = await embedBatch(["a", "b"], undefined, undefined, { target: envEmbeddingTarget(), allowHostedOnLocal: true });
    assert.equal(vecs.length, 2);
    assert.equal(calls[0].url, "https://api.openai.com/v1/embeddings", "the hosted corpus stays OpenAI-embedded");
    assert.equal(calls[0].body.dimensions, 512);
  });

  test("...but still refuses a missing/placeholder OpenAI key", async () => {
    setup("ollama", true);
    process.env.OPENAI_API_KEY = "sk-...";
    await assert.rejects(
      () => embedBatch(["a"], undefined, undefined, { target: envEmbeddingTarget(), allowHostedOnLocal: true }),
      /OPENAI_API_KEY is missing or still the \.env\.example placeholder/,
    );
  });

  test("a search pinning the hosted target while Local is selected still gets the 'not ready yet' guard", async () => {
    setup("ollama", false);
    process.env.OPENAI_API_KEY = "sk-proj-abcdefghijklmnopqrstuvwxyz1234567890";
    const calls = captureFetch();
    await assert.rejects(() => embed("x", undefined, undefined, { target: envEmbeddingTarget() }), /Local LLM is set/);
    assert.equal(calls.length, 0);
  });
});
