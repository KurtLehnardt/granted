import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  classifyOllamaStatus,
  effectiveLocalModel,
  isEmbeddingModel,
  isValidModelTag,
  normalizeModelTag,
  resolveDefaultLocalModel,
  sameModel,
} from "../ollamaModels";
import { detectOllamaInstalled, isLocalHost, splitModels, suggestModels } from "../ollamaStatus";

const base = { installed: true, running: true, isOllama: true, chatModels: [{ name: "llama3.2:1b" }], model: "llama3.2:1b" };

describe("classifyOllamaStatus", () => {
  test("not installed: nothing answers and no Ollama on the machine", () => {
    assert.equal(classifyOllamaStatus({ ...base, installed: false, running: false, isOllama: false }), "not_installed");
  });
  test("not running: installed, nothing answers", () => {
    assert.equal(classifyOllamaStatus({ ...base, running: false, isOllama: false }), "not_running");
  });
  test("no chat models: running with none, or with embedding models only (those are filtered before this)", () => {
    assert.equal(classifyOllamaStatus({ ...base, chatModels: [] }), "no_chat_models");
  });
  test("model missing: the user's report — gemma4:latest configured, llama3.2:1b installed", () => {
    assert.equal(classifyOllamaStatus({ ...base, model: "gemma4:latest" }), "model_missing");
  });
  test("ok: the model is installed (a bare name matches its :latest tag)", () => {
    assert.equal(classifyOllamaStatus(base), "ok");
    assert.equal(classifyOllamaStatus({ ...base, chatModels: [{ name: "gemma4:latest" }], model: "gemma4" }), "ok");
  });
  test("external: an OpenAI-compatible server that isn't Ollama", () => {
    assert.equal(classifyOllamaStatus({ ...base, isOllama: false, chatModels: [] }), "external");
  });
});

describe("isEmbeddingModel / splitModels — embedding models are never offered as chat models", () => {
  test("by name", () => {
    for (const name of ["nomic-embed-text", "nomic-embed-text:latest", "mxbai-embed-large", "all-minilm:l6-v2", "bge-m3", "snowflake-arctic-embed:110m"]) {
      assert.equal(isEmbeddingModel({ name }), true, name);
    }
    for (const name of ["llama3.2:1b", "qwen2.5:7b", "gemma4:latest", "mistral-nemo", "phi3.5:3.8b", "deepseek-r1:8b"]) {
      assert.equal(isEmbeddingModel({ name }), false, name);
    }
  });
  test("by family, for an embedding model with an unhelpful name", () => {
    assert.equal(isEmbeddingModel({ name: "my-search-model", details: { family: "nomic-bert" } }), true);
    assert.equal(isEmbeddingModel({ name: "my-chat", details: { family: "llama", families: ["llama"] } }), false);
  });
  test("splitModels: chat models with sizes, embedding names apart", () => {
    const out = splitModels([
      { name: "llama3.2:1b", details: { parameter_size: "1.2B", family: "llama" } },
      { name: "nomic-embed-text:latest", details: { parameter_size: "137M", family: "nomic-bert" } },
    ]);
    assert.deepEqual(out.chatModels, [{ name: "llama3.2:1b", paramsB: 1.2 }]);
    assert.deepEqual(out.embeddingModels, ["nomic-embed-text:latest"]);
  });
});

describe("model names", () => {
  test("normalizeModelTag / sameModel", () => {
    assert.equal(normalizeModelTag("gemma4"), "gemma4:latest");
    assert.equal(normalizeModelTag("qwen2.5:7b"), "qwen2.5:7b");
    assert.equal(normalizeModelTag("hf.co/org/repo"), "hf.co/org/repo:latest");
    assert.equal(sameModel("Gemma4", "gemma4:latest"), true);
    assert.equal(sameModel("qwen2.5:7b", "qwen2.5:14b"), false);
    assert.equal(sameModel(null, "x"), false);
  });
  test("effectiveLocalModel: the pick when installed, else the default", () => {
    const installed = ["llama3.2:1b", "qwen2.5:7b"];
    assert.equal(effectiveLocalModel("qwen2.5:7b", installed, "gemma4:latest"), "qwen2.5:7b");
    assert.equal(effectiveLocalModel("deleted:1b", installed, "gemma4:latest"), "gemma4:latest");
    assert.equal(effectiveLocalModel(null, installed, "gemma4:latest"), "gemma4:latest");
    assert.equal(effectiveLocalModel(null, ["gemma4:latest"], "gemma4"), "gemma4:latest");
  });
  test("isValidModelTag", () => {
    for (const t of ["qwen2.5:7b", "llama3.2", "hf.co/bartowski/Llama-3.2-1B-Instruct-GGUF:Q4_K_M"]) assert.equal(isValidModelTag(t), true, t);
    for (const t of ["", " ", "a b", "../etc", "x;rm -rf", 5, null, "-flag"]) assert.equal(isValidModelTag(t), false, String(t));
  });
});

describe("ollamaStatus helpers", () => {
  test("suggestModels: setup-local's tier for the memory first, then alternatives that fit", () => {
    const s16 = suggestModels(16);
    assert.equal(s16.recommended.model, "qwen2.5:7b");
    assert.equal(s16.recommended.memGB, 16);
    assert.deepEqual(s16.suggestions, ["qwen2.5:7b", "llama3.1:8b", "llama3.2:3b", "llama3.2:1b"]);
    assert.equal(suggestModels(4).recommended.model, "llama3.2:1b");
    assert.equal(suggestModels(null).recommended.model, "llama3.2:1b", "unknown memory never over-recommends");
  });
  test("isLocalHost", () => {
    assert.equal(isLocalHost("http://localhost:11434"), true);
    assert.equal(isLocalHost("http://127.0.0.1:11434"), true);
    assert.equal(isLocalHost("http://gpu-box.lan:11434"), false);
  });
  test("detectOllamaInstalled: Windows install dir, else `ollama --version`", () => {
    const env = { LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local" };
    const seen: string[] = [];
    const found = detectOllamaInstalled({
      platform: "win32",
      env,
      exists: (p) => (seen.push(p), p.endsWith("ollama app.exe")),
      ollamaVersionStatus: () => assert.fail("no need to spawn when the app is on disk"),
    });
    assert.equal(found, true);
    assert.ok(seen.some((p) => p.startsWith("C:\\Users\\u\\AppData\\Local\\Programs\\Ollama")));

    assert.equal(detectOllamaInstalled({ platform: "linux", env: {}, exists: () => false, ollamaVersionStatus: () => 0 }), true);
    assert.equal(detectOllamaInstalled({ platform: "linux", env: {}, exists: () => false, ollamaVersionStatus: () => null }), false);
  });
});

describe("resolveDefaultLocalModel — Default is always an installed chat model when there is one", () => {
  test("LOCAL_LLM_MODEL installed -> it (a bare name matches its :latest tag)", () => {
    assert.equal(resolveDefaultLocalModel("llama3.2:1b", ["qwen2.5:7b", "llama3.2:1b"]), "llama3.2:1b");
    assert.equal(resolveDefaultLocalModel("gemma4", ["gemma4:latest", "qwen2.5:7b"]), "gemma4:latest");
  });
  test("LOCAL_LLM_MODEL not installed -> the best installed model in MODEL_TIERS order (the user's machine)", () => {
    assert.equal(resolveDefaultLocalModel("gemma4:latest", ["llama3.2:1b", "qwen2.5:7b"]), "qwen2.5:7b");
    assert.equal(resolveDefaultLocalModel("gemma4:latest", ["qwen2.5:1.5b", "llama3.2:3b"]), "llama3.2:3b");
  });
  test("no tier model installed -> the first installed chat model", () => {
    assert.equal(resolveDefaultLocalModel("gemma4:latest", ["mistral:7b", "phi3:mini"]), "mistral:7b");
  });
  test("none installed -> the configured model (reported as missing)", () => {
    assert.equal(resolveDefaultLocalModel("gemma4:latest", []), "gemma4:latest");
  });
  test("only embedding models installed -> never an embedding model; the configured one", () => {
    assert.equal(resolveDefaultLocalModel("gemma4:latest", ["nomic-embed-text:latest", "mxbai-embed-large"]), "gemma4:latest");
  });
});
