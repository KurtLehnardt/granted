import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  parseParamsB,
  isEmbeddingModel,
  listOllamaModels,
  listOllamaChatModels,
  resetOllamaModelsCache,
} from "../ollamaInfo";

const realFetch = globalThis.fetch;
const savedBaseUrl = process.env.LLM_BASE_URL;

afterEach(() => {
  globalThis.fetch = realFetch;
  if (savedBaseUrl === undefined) delete process.env.LLM_BASE_URL;
  else process.env.LLM_BASE_URL = savedBaseUrl;
  resetOllamaModelsCache();
});

describe("parseParamsB", () => {
  test("parses Ollama's parameter_size format", () => {
    assert.equal(parseParamsB("3.1B"), 3.1);
    assert.equal(parseParamsB("70B"), 70);
    assert.equal(parseParamsB("7b"), 7);
  });
  test("non-B units or missing -> undefined", () => {
    assert.equal(parseParamsB("770M"), undefined);
    assert.equal(parseParamsB(undefined), undefined);
    assert.equal(parseParamsB(""), undefined);
  });
});

describe("isEmbeddingModel", () => {
  test("matches names containing 'embed'", () => {
    assert.equal(isEmbeddingModel("nomic-embed-text"), true);
    assert.equal(isEmbeddingModel("mxbai-embed-large"), true);
  });
  test("chat models don't match", () => {
    assert.equal(isEmbeddingModel("gemma3:12b"), false);
  });
});

describe("listOllamaModels / listOllamaChatModels", () => {
  test("fetches /api/tags at the host (LLM_BASE_URL minus /v1), caches, excludes embedding models from the chat list", async () => {
    process.env.LLM_BASE_URL = "http://localhost:11434/v1";
    let calls = 0;
    let requestedUrl = "";
    globalThis.fetch = (async (url: string) => {
      calls++;
      requestedUrl = String(url);
      return {
        ok: true,
        json: async () => ({
          models: [
            { name: "gemma3:12b", details: { parameter_size: "12B" } },
            { name: "nomic-embed-text", details: { parameter_size: "137M" } },
          ],
        }),
      };
    }) as unknown as typeof fetch;

    const all = await listOllamaModels();
    assert.equal(requestedUrl, "http://localhost:11434/api/tags");
    assert.deepEqual(all, [
      { name: "gemma3:12b", paramsB: 12 },
      { name: "nomic-embed-text", paramsB: undefined },
    ]);

    const chat = await listOllamaChatModels();
    assert.deepEqual(chat, [{ name: "gemma3:12b", paramsB: 12 }]);

    // second call reuses the cache — fetch is not called again
    await listOllamaModels();
    assert.equal(calls, 1);
  });

  test("fails soft to [] on a non-OK response or network error", async () => {
    globalThis.fetch = (async () => ({ ok: false })) as unknown as typeof fetch;
    assert.deepEqual(await listOllamaModels(), []);

    resetOllamaModelsCache();
    globalThis.fetch = (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch;
    assert.deepEqual(await listOllamaModels(), []);
  });

  test("a failed/empty lookup is NOT cached — the next call retries instead of failing forever", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return { ok: false };
    }) as unknown as typeof fetch;
    assert.deepEqual(await listOllamaModels(), []);
    assert.deepEqual(await listOllamaModels(), []);
    assert.equal(calls, 2, "an empty result must not be cached");

    // Once Ollama comes up, the very next call (no manual cache reset) succeeds.
    globalThis.fetch = (async () => ({
      ok: true,
      json: async () => ({ models: [{ name: "gemma3:12b", details: { parameter_size: "12B" } }] }),
    })) as unknown as typeof fetch;
    assert.deepEqual(await listOllamaModels(), [{ name: "gemma3:12b", paramsB: 12 }]);
  });
});
