import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { embed, embedBatch, checkEmbeddingsMisconfig } from "../embed";

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
      /Local LLM is set \(LLM_PROVIDER\) but embeddings still target OpenAI/,
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
      /Local LLM is set \(LLM_PROVIDER\) but embeddings still target OpenAI/,
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
      /Local LLM is set \(LLM_PROVIDER\) but embeddings still target OpenAI/,
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
