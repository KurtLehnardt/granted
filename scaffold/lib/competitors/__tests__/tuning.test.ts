import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { buildWebQuery } from "../analyze";
import { embedBatch } from "../../embed";

/**
 * R5-deep — the web-relevance + latency tuning.
 *
 *   1. `buildWebQuery` — leads the exa query with the persona + the distinctive
 *      profile keywords (the sector signal a raw description drowns out), and
 *      drops the generic "startups and companies comparable to" boilerplate.
 *   2. `embedBatch` — the rerank hot path: one request for many inputs, returned
 *      in INPUT order (via each item's `index`), chunked + flattened for large N.
 *      A serial per-record embed loop was the dominant latency sink.
 */

describe("buildWebQuery — weaves the distinctive keywords into the exa query", () => {
  test("leads with persona + keywords and drops the generic boilerplate", () => {
    const q = buildWebQuery({
      persona: "FasterControl",
      personaDescription: "Cloud MES and QMS for federal biomanufacturers.",
      keywords: ["biomanufacturing", "BARDA", "21 CFR Part 11", "biologics"],
    });
    assert.match(q, /FasterControl/);
    assert.match(q, /biomanufacturing/);
    assert.match(q, /BARDA/);
    assert.match(q, /21 CFR Part 11/);
    // The old query's diluting boilerplate must be gone.
    assert.doesNotMatch(q, /startups and companies comparable to/i);
  });

  test("an explicit webQuery override always wins", () => {
    const q = buildWebQuery({
      persona: "X",
      personaDescription: "desc long enough to matter",
      keywords: ["ignored"],
      webQuery: "  a very specific custom query  ",
    });
    assert.equal(q, "a very specific custom query");
  });

  test("caps at 8 keywords and never emits a dangling separator with none", () => {
    const many = Array.from({ length: 20 }, (_, i) => `kw${i}`);
    const withMany = buildWebQuery({ persona: "P", personaDescription: "d", keywords: many });
    assert.ok(withMany.includes("kw7"), "keeps the first 8");
    assert.ok(!withMany.includes("kw8"), "drops the 9th onward");

    const none = buildWebQuery({ persona: "P", personaDescription: "just a description" });
    assert.doesNotMatch(none, /—/); // no trailing/empty separator when there are no keywords
    assert.match(none, /Companies similar to P\. just a description/);
  });
});

describe("embedBatch — one request per chunk, results in input order", () => {
  const realFetch = globalThis.fetch;
  const realKey = process.env.OPENAI_API_KEY;
  let calls = 0;

  afterEach(() => {
    globalThis.fetch = realFetch;
    if (realKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = realKey;
    calls = 0;
  });

  // Fake OpenAI: echoes each input's position as its embedding, but returns the
  // data array SHUFFLED — so a correct impl must sort by `index`, not trust order.
  function installFakeOpenAI() {
    // Long enough to clear embed.ts's placeholder-key guard (real sk-/sk-proj-
    // keys are dozens of chars; anything under ~20 is treated as a placeholder).
    process.env.OPENAI_API_KEY = "sk-test-1234567890abcdef";
    globalThis.fetch = (async (_url: string, init: any) => {
      calls++;
      const body = JSON.parse(init.body);
      const inputs: string[] = body.input;
      const data = inputs.map((_t, i) => ({ index: i, embedding: [i, i] }));
      // shuffle: reverse the data order to prove index-sorting is applied
      data.reverse();
      return {
        ok: true,
        json: async () => ({ data, usage: { prompt_tokens: inputs.length } }),
      };
    }) as unknown as typeof fetch;
  }

  test("returns [] without touching the network for empty input", async () => {
    installFakeOpenAI();
    const out = await embedBatch([]);
    assert.deepEqual(out, []);
    assert.equal(calls, 0);
  });

  test("small input → one call, vectors in input order despite shuffled response", async () => {
    installFakeOpenAI();
    const out = await embedBatch(["a", "b", "c"]);
    assert.equal(calls, 1);
    assert.deepEqual(out, [[0, 0], [1, 1], [2, 2]]);
  });

  test("large input → chunks of 128, flattened back in global input order", async () => {
    installFakeOpenAI();
    const texts = Array.from({ length: 130 }, (_, i) => `t${i}`);
    const out = await embedBatch(texts);
    assert.equal(calls, 2); // 128 + 2
    assert.equal(out.length, 130);
    // Each chunk echoes its LOCAL index, so after flatten the 129th item (local 0
    // of chunk 2) is [0,0] — proving chunks are concatenated in order.
    assert.deepEqual(out[0], [0, 0]);
    assert.deepEqual(out[127], [127, 127]);
    assert.deepEqual(out[128], [0, 0]);
    assert.deepEqual(out[129], [1, 1]);
  });

  test("throws without a key", async () => {
    delete process.env.OPENAI_API_KEY;
    // The preflight guard (embed.ts's assertEmbeddingsConfigured) now catches
    // this before the network call, with a clearer message than the old
    // fallback ("OPENAI_API_KEY is not set") that only fired inside fetch.
    await assert.rejects(() => embedBatch(["x"]), /OPENAI_API_KEY is missing or still the \.env\.example placeholder/);
  });
});
