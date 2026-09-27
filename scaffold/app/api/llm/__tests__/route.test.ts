import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { GET, dynamic } from "../route";
import { resetOllamaModelsCache } from "@/lib/llm/ollamaInfo";

/**
 * GET /api/llm — Settings' local-only model picker backend. Hosted must never
 * call Ollama; local returns the active default + installed chat models.
 */

const savedProvider = process.env.LLM_PROVIDER;
const savedModel = process.env.LOCAL_LLM_MODEL;
const realFetch = globalThis.fetch;

afterEach(() => {
  if (savedProvider === undefined) delete process.env.LLM_PROVIDER;
  else process.env.LLM_PROVIDER = savedProvider;
  if (savedModel === undefined) delete process.env.LOCAL_LLM_MODEL;
  else process.env.LOCAL_LLM_MODEL = savedModel;
  globalThis.fetch = realFetch;
  resetOllamaModelsCache();
});

describe("GET /api/llm", () => {
  // A no-argument GET with no segment config gets statically prerendered by
  // Next 14 — freezing the Ollama model list (and hosted/local) at build
  // time. This is the guard against that regression; a real `next build`
  // is what actually verifies the route isn't emitted as `○ (Static)`.
  test("opts out of static prerendering", () => {
    assert.equal(dynamic, "force-dynamic");
  });

  test("hosted -> { local: false }, no Ollama call", async () => {
    delete process.env.LLM_PROVIDER;
    let fetched = false;
    globalThis.fetch = (async () => { fetched = true; return { ok: true, json: async () => ({}) }; }) as unknown as typeof fetch;

    const res = await GET();
    const j = await res.json();
    assert.deepEqual(j, { local: false });
    assert.equal(fetched, false, "hosted must never call Ollama");
  });

  test("local -> active model + installed chat models (embedding models excluded)", async () => {
    process.env.LLM_PROVIDER = "ollama";
    process.env.LOCAL_LLM_MODEL = "gemma3:12b";
    globalThis.fetch = (async () => ({
      ok: true,
      json: async () => ({
        models: [
          { name: "gemma3:12b", details: { parameter_size: "12B" } },
          { name: "nomic-embed-text", details: { parameter_size: "137M" } },
        ],
      }),
    })) as unknown as typeof fetch;

    const res = await GET();
    const j = await res.json();
    assert.equal(j.local, true);
    assert.equal(j.model, "gemma3:12b");
    assert.deepEqual(j.models, [{ name: "gemma3:12b", paramsB: 12 }]);
  });
});
