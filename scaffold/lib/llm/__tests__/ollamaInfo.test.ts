import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { parseParamsB, listOllamaChatModels } from "../ollamaInfo";

const realFetch = globalThis.fetch;
const savedBaseUrl = process.env.LLM_BASE_URL;

afterEach(() => {
  globalThis.fetch = realFetch;
  if (savedBaseUrl === undefined) delete process.env.LLM_BASE_URL;
  else process.env.LLM_BASE_URL = savedBaseUrl;
});

function mockTags(models: unknown[]): { calls: string[] } {
  const seen = { calls: [] as string[] };
  globalThis.fetch = (async (url: string) => {
    seen.calls.push(String(url));
    return { ok: true, json: async () => ({ models }) };
  }) as unknown as typeof fetch;
  return seen;
}

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

describe("listOllamaChatModels", () => {
  test("queries /api/tags on the host (LLM_BASE_URL minus /v1) and excludes embedding models", async () => {
    process.env.LLM_BASE_URL = "http://localhost:11434/v1";
    const seen = mockTags([
      { name: "gemma3:12b", details: { parameter_size: "12B" } },
      { name: "nomic-embed-text", details: { parameter_size: "137M" } },
      { name: "mxbai-embed-large" },
    ]);
    assert.deepEqual(await listOllamaChatModels(), [{ name: "gemma3:12b", paramsB: 12 }]);
    assert.deepEqual(seen.calls, ["http://localhost:11434/api/tags"]);
  });

  test("reflects newly pulled models on the next call (no stale cache)", async () => {
    mockTags([{ name: "gemma3:12b", details: { parameter_size: "12B" } }]);
    assert.equal((await listOllamaChatModels()).length, 1);
    mockTags([
      { name: "gemma3:12b", details: { parameter_size: "12B" } },
      { name: "qwen2.5:7b", details: { parameter_size: "7B" } },
    ]);
    assert.deepEqual((await listOllamaChatModels()).map((m) => m.name), ["gemma3:12b", "qwen2.5:7b"]);
  });

  test("fails soft to [] on a non-OK response or network error", async () => {
    globalThis.fetch = (async () => ({ ok: false })) as unknown as typeof fetch;
    assert.deepEqual(await listOllamaChatModels(), []);
    globalThis.fetch = (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch;
    assert.deepEqual(await listOllamaChatModels(), []);
  });
});
