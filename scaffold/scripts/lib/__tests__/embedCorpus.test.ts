import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { corpusDims, corpusEmbedText, embedOpportunities, embeddingsBody, postEmbeddings, EmbeddingsTimeoutError } from "../embedCorpus.mjs";
import { opportunityEmbedText } from "../../../lib/corpus/refresh";

/** The corpus-embedding loop shared by 3-embed.mjs and the Settings-driven local re-embed. No network: fetch is injected. */

type Call = { url: string; body: any };

function fakeFetch(responder: (body: any, n: number) => { status?: number; json?: unknown; headers?: Record<string, string> }) {
  const calls: Call[] = [];
  const fn = (async (url: string, init: { body: string }) => {
    const body = JSON.parse(init.body);
    calls.push({ url, body });
    const r = responder(body, calls.length);
    const status = r.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (k: string) => r.headers?.[k.toLowerCase()] ?? null },
      json: async () => r.json,
      text: async () => JSON.stringify(r.json ?? {}),
    };
  }) as unknown as typeof fetch;
  return { fn, calls };
}

const vectorsFor = (input: string[], dims = 3) => ({ data: input.map((_, i) => ({ index: i, embedding: Array(dims).fill(0.123456789) })) });
const opp = (i: number) => ({ id: `o${i}`, program: `P${i}`, agency: "A", description: "D" });

describe("embedCorpus", () => {
  test("corpusEmbedText matches lib/corpus/refresh's opportunityEmbedText (reused vectors stay comparable)", () => {
    const o = { program: "Prog", agency: "Agency", description: "x".repeat(9000) } as any;
    assert.equal(corpusEmbedText(o), opportunityEmbedText(o));
    assert.equal(corpusEmbedText(o).length, 8000);
  });

  test("embeddingsBody sends `dimensions` only when set", () => {
    assert.deepEqual(JSON.parse(embeddingsBody("m", 512, ["a"])), { model: "m", dimensions: 512, input: ["a"] });
    assert.deepEqual(JSON.parse(embeddingsBody("m", undefined, ["a"])), { model: "m", input: ["a"] });
  });

  test("embedOpportunities batches, rounds, sets embeddings in place and reports progress", async () => {
    const { fn, calls } = fakeFetch((body) => ({ json: vectorsFor(body.input) }));
    const opps = [1, 2, 3, 4, 5].map(opp) as any[];
    const progress: Array<[number, number]> = [];
    await embedOpportunities(opps, {
      baseUrl: "http://ollama.test/v1",
      model: "nomic-embed-text",
      batch: 2,
      fetchFn: fn,
      onProgress: (d: number, t: number) => progress.push([d, t]),
    });
    assert.equal(calls.length, 3);
    assert.equal(calls[0].url, "http://ollama.test/v1/embeddings");
    assert.deepEqual(calls[0].body, { model: "nomic-embed-text", input: ["P1. A. D", "P2. A. D"] });
    assert.deepEqual(progress, [[2, 5], [4, 5], [5, 5]]);
    assert.deepEqual(opps[4].embedding, [0.12346, 0.12346, 0.12346]);
    assert.equal(corpusDims(opps), 3);
  });

  test("postEmbeddings orders vectors by `index`, not response order", async () => {
    const { fn } = fakeFetch(() => ({ json: { data: [{ index: 1, embedding: [2] }, { index: 0, embedding: [1] }] } }));
    const data = await postEmbeddings({ baseUrl: "http://x/v1", model: "m", inputs: ["a", "b"], fetchFn: fn });
    assert.deepEqual(data.map((d: { embedding: number[] }) => d.embedding), [[1], [2]]);
  });

  test("postEmbeddings backs off on 429/5xx (honoring Retry-After) and then succeeds", async () => {
    const { fn, calls } = fakeFetch((body, n) =>
      n === 1 ? { status: 429, headers: { "retry-after": "2" } } : n === 2 ? { status: 503 } : { json: vectorsFor(body.input) },
    );
    const waits: number[] = [];
    const data = await postEmbeddings({
      baseUrl: "http://x/v1",
      model: "m",
      inputs: ["a"],
      fetchFn: fn,
      sleepFn: async (ms: number) => void waits.push(ms),
    });
    assert.equal(calls.length, 3);
    assert.deepEqual(waits, [2000, 2000]);
    assert.equal(data.length, 1);
  });

  test("postEmbeddings gives up after maxRetries and surfaces a non-retryable error immediately", async () => {
    const always503 = fakeFetch(() => ({ status: 503 }));
    await assert.rejects(
      postEmbeddings({ baseUrl: "http://x/v1", model: "m", inputs: ["a"], fetchFn: always503.fn, sleepFn: async () => {}, maxRetries: 2 }),
      /Gave up after 2 retries/,
    );
    assert.equal(always503.calls.length, 3);

    const notFound = fakeFetch(() => ({ status: 404, json: { error: "model not found" } }));
    await assert.rejects(
      postEmbeddings({ baseUrl: "http://x/v1", model: "m", inputs: ["a"], fetchFn: notFound.fn }),
      /Embeddings failed \(404\).*model not found/,
    );
    assert.equal(notFound.calls.length, 1);
  });

  test("a response with the wrong number of vectors is an error, never a silently misaligned corpus", async () => {
    const { fn } = fakeFetch(() => ({ json: { data: [{ embedding: [1] }] } }));
    await assert.rejects(postEmbeddings({ baseUrl: "http://x/v1", model: "m", inputs: ["a", "b"], fetchFn: fn }), /1 vectors for 2 inputs/);
  });

  test("shouldStop aborts between batches", async () => {
    const { fn, calls } = fakeFetch((body) => ({ json: vectorsFor(body.input) }));
    let stop = false;
    await assert.rejects(
      embedOpportunities([1, 2, 3].map(opp) as any[], {
        baseUrl: "http://x/v1",
        model: "m",
        batch: 1,
        fetchFn: fn,
        onProgress: () => (stop = true),
        shouldStop: () => stop,
      }),
      /Stopped/,
    );
    assert.equal(calls.length, 1);
  });
});

describe("embedCorpus — timeouts", () => {
  test("timeoutMs aborts a request that never answers with an EmbeddingsTimeoutError", { timeout: 5000 }, async () => {
    let sawSignal = false;
    const hang = (async (_url: string, init: { signal?: AbortSignal }) => {
      sawSignal = Boolean(init.signal);
      return new Promise((_, reject) => init.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
    }) as unknown as typeof fetch;
    await assert.rejects(
      postEmbeddings({ baseUrl: "http://x/v1", model: "m", inputs: ["a"], fetchFn: hang, timeoutMs: 50 }),
      (e: unknown) => e instanceof EmbeddingsTimeoutError && /didn't answer within/.test((e as Error).message),
    );
    assert.equal(sawSignal, true);
  });

  test("without timeoutMs no signal is attached (3-embed.mjs's behaviour is unchanged)", async () => {
    let signal: unknown = "unset";
    const ok = (async (_url: string, init: { signal?: AbortSignal; body: string }) => {
      signal = init.signal;
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ data: [{ embedding: [1] }] }) };
    }) as unknown as typeof fetch;
    await postEmbeddings({ baseUrl: "http://x/v1", model: "m", inputs: ["a"], fetchFn: ok });
    assert.equal(signal, undefined);
  });
});
