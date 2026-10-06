import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  embed,
  embedBatch,
  checkOpenAiEmbeddingsKey,
  assertEmbeddingDimsMatch,
  httpTargetForSpace,
  withSpacePrefixes,
} from "../embed";
import { getSpace } from "../embeddings/spaces";
import { createCostMeter } from "../metering/meter";
import { resetBuiltinRuntime } from "../embeddings/builtin";

/**
 * lib/embed.ts routes every embedding through an embedding space
 * (lib/embeddings/spaces.ts): OpenAI over HTTP, a custom embedder over HTTP, or
 * the built-in model in this process. These tests pin the HTTP requests each
 * space makes, the prefixes, the key guard, and that the built-in space never
 * reaches the network.
 */

const ENV_KEYS = ["LLM_PROVIDER", "OPENAI_API_KEY", "EMBEDDINGS_API_KEY", "SEARCH_EMBEDDINGS", "EMBEDDINGS_BASE_URL", "GRANTED_MODELS_DIR"] as const;
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
const realFetch = globalThis.fetch;

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  globalThis.fetch = realFetch;
  resetBuiltinRuntime();
});

const REAL_LOOKING_KEY = "sk-proj-abcdefghijklmnopqrstuvwxyz1234567890";

function captureFetch() {
  const calls: Array<{ url: string; body: any; auth: string }> = [];
  globalThis.fetch = (async (url: string, init: { body: string; headers: Record<string, string> }) => {
    calls.push({ url, body: JSON.parse(init.body), auth: init.headers.Authorization });
    const input = JSON.parse(init.body).input;
    const n = Array.isArray(input) ? input.length : 1;
    return {
      ok: true,
      json: async () => ({ data: Array.from({ length: n }, (_, index) => ({ index, embedding: [1, 2, 3] })), usage: { prompt_tokens: 7 } }),
    };
  }) as unknown as typeof fetch;
  return calls;
}

describe("checkOpenAiEmbeddingsKey — pure guard", () => {
  test("no-op for a non-OpenAI endpoint, whatever the key", () => {
    assert.doesNotThrow(() => checkOpenAiEmbeddingsKey(false, undefined));
  });

  test("missing or placeholder key -> names SEARCH_EMBEDDINGS=auto as the no-key way out", () => {
    for (const key of [undefined, "", "sk-...", "short"]) {
      assert.throws(
        () => checkOpenAiEmbeddingsKey(true, key),
        (e: Error) => /OPENAI_API_KEY is missing/.test(e.message) && /SEARCH_EMBEDDINGS=auto/.test(e.message),
      );
    }
  });

  test("a plausible real key passes", () => {
    assert.doesNotThrow(() => checkOpenAiEmbeddingsKey(true, REAL_LOOKING_KEY));
  });
});

describe("HTTP spaces", () => {
  test("openai: always OpenAI text-embedding-3-small @ 512, even with a custom EMBEDDINGS_BASE_URL", () => {
    const t = httpTargetForSpace(getSpace("openai"), { baseUrl: "http://localhost:11434/v1", model: "nomic-embed-text" });
    assert.deepEqual(t, { baseUrl: "https://api.openai.com/v1", model: "text-embedding-3-small", dimensions: 512, isOpenAi: true });
  });

  test("custom: follows EMBEDDINGS_BASE_URL / EMBEDDINGS_MODEL, no `dimensions` for a local model", () => {
    const t = httpTargetForSpace(getSpace("custom"), { baseUrl: "http://localhost:11434", model: "nomic-embed-text" });
    assert.deepEqual(t, { baseUrl: "http://localhost:11434/v1", model: "nomic-embed-text", dimensions: undefined, isOpenAi: false });
  });

  test("embed() on OpenAI sends one string with 512 dims and the key, and meters it as openai", async () => {
    process.env.OPENAI_API_KEY = REAL_LOOKING_KEY;
    const calls = captureFetch();
    const meter = createCostMeter();
    const v = await embed("hello", meter, undefined, { space: getSpace("openai") });
    assert.deepEqual(v, [1, 2, 3]);
    assert.equal(calls[0].url, "https://api.openai.com/v1/embeddings");
    assert.deepEqual(calls[0].body, { model: "text-embedding-3-small", dimensions: 512, input: "hello" });
    assert.equal(calls[0].auth, `Bearer ${REAL_LOOKING_KEY}`);
    assert.equal(meter.summary().stages[0].provider, "openai");
  });

  test("SEARCH_EMBEDDINGS=openai with no key fails before any network call", async () => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.EMBEDDINGS_API_KEY;
    const calls = captureFetch();
    await assert.rejects(() => embed("hello", undefined, undefined, { space: getSpace("openai") }), /SEARCH_EMBEDDINGS=openai/);
    assert.equal(calls.length, 0);
  });

  test("embedBatch() keeps input order (sorted by index) and never sends the OpenAI key to a custom embedder's 'local' fallback", async () => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.EMBEDDINGS_API_KEY;
    process.env.EMBEDDINGS_BASE_URL = "http://localhost:11434/v1";
    globalThis.fetch = (async (_url: string, init: { body: string; headers: Record<string, string> }) => {
      const input = JSON.parse(init.body).input as string[];
      assert.equal(init.headers.Authorization, "Bearer local");
      return {
        ok: true,
        json: async () => ({ data: input.map((_, index) => ({ index, embedding: [index] })).reverse(), usage: {} }),
      };
    }) as unknown as typeof fetch;
    const meter = createCostMeter();
    const out = await embedBatch(["a", "b", "c"], meter, undefined, { space: getSpace("custom") });
    assert.deepEqual(out, [[0], [1], [2]]);
    assert.equal(meter.summary().stages[0].provider, "custom", "a self-hosted embedder is never metered as OpenAI");
    assert.equal(meter.summary().totalCostUsd, 0);
  });
});

describe("prefixes", () => {
  test("built-in: search_query for queries, search_document for programs; a mixed batch per text", () => {
    const s = getSpace("builtin");
    assert.deepEqual(withSpacePrefixes(s, ["q"], "query"), ["search_query: q"]);
    assert.deepEqual(withSpacePrefixes(s, ["d"], "document"), ["search_document: d"]);
    assert.deepEqual(withSpacePrefixes(s, ["p", "r1", "r2"], ["query", "document", "document"]), [
      "search_query: p",
      "search_document: r1",
      "search_document: r2",
    ]);
  });

  test("OpenAI: no prefixes, so its vectors stay exactly as before", () => {
    assert.deepEqual(withSpacePrefixes(getSpace("openai"), ["q"], "query"), ["q"]);
  });
});

describe("built-in space", () => {
  test("is the active space with no OpenAI key, and never touches the network (model missing -> says how to fetch it)", async () => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.EMBEDDINGS_API_KEY;
    delete process.env.EMBEDDINGS_BASE_URL;
    delete process.env.SEARCH_EMBEDDINGS;
    delete process.env.LLM_PROVIDER;
    const calls = captureFetch();
    await assert.rejects(() => embed("hello"), /model:fetch/);
    assert.equal(calls.length, 0);
  });
});

/**
 * The dimension-mismatch guard: a query and corpus from different models make
 * cosine() read past the shorter vector — a silent, confusing "weak field".
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
