import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { EMBEDDING_SPACES, getSpace, resolveSearchSpace } from "../spaces";
import { CALIBRATION } from "../../match";
import { customEmbedderFromEnv } from "../../../scripts/lib/spaces.mjs";

const KEY = "sk-proj-abcdefghijklmnopqrstuvwxyz1234567890";

describe("resolveSearchSpace — which embeddings search uses", () => {
  const cases: Array<[string, Parameters<typeof resolveSearchSpace>[0], string, string]> = [
    ["auto + OpenAI key (existing users) -> OpenAI", { provider: "cloud", openAiKey: KEY }, "openai", "OpenAI key present"],
    ["auto + no key at all -> built-in", { provider: "cloud" }, "builtin", "No OpenAI key"],
    ["auto + only a Claude key (no OpenAI key reaches this) -> built-in", { provider: "cloud", openAiKey: "" }, "builtin", "No OpenAI key"],
    ["auto + the .env.example placeholder -> built-in", { provider: "cloud", openAiKey: "sk-..." }, "builtin", "No OpenAI key"],
    ["auto + a truncated key -> built-in", { provider: "cloud", openAiKey: "sk-abc" }, "builtin", "No OpenAI key"],
    ["auto + Local (Ollama), even with an OpenAI key -> built-in", { provider: "ollama", openAiKey: KEY }, "builtin", "Local model selected"],
    ["auto + EMBEDDINGS_BASE_URL at Ollama (a setup:local from before) -> custom", { provider: "ollama", embeddingsBaseUrl: "http://localhost:11434/v1" }, "custom", "EMBEDDINGS_BASE_URL is set"],
    ["auto + EMBEDDINGS_BASE_URL at OpenAI itself -> not custom", { provider: "cloud", openAiKey: KEY, embeddingsBaseUrl: "https://api.openai.com/v1" }, "openai", "OpenAI key present"],
    ["SEARCH_EMBEDDINGS=builtin wins over a key", { setting: "builtin", provider: "cloud", openAiKey: KEY }, "builtin", "SEARCH_EMBEDDINGS=builtin"],
    ["SEARCH_EMBEDDINGS=builtin wins over a custom embedder", { setting: "builtin", provider: "cloud", embeddingsBaseUrl: "http://localhost:11434/v1" }, "builtin", "SEARCH_EMBEDDINGS=builtin"],
    ["SEARCH_EMBEDDINGS=openai with no key -> openai (the missing key is reported when search runs)", { setting: "openai", provider: "cloud" }, "openai", "SEARCH_EMBEDDINGS=openai"],
    ["SEARCH_EMBEDDINGS=openai on Local -> openai (explicit choice)", { setting: "openai", provider: "ollama", openAiKey: KEY }, "openai", "SEARCH_EMBEDDINGS=openai"],
    ["an unknown SEARCH_EMBEDDINGS value counts as auto", { setting: "nomic", provider: "cloud" }, "builtin", "No OpenAI key"],
    ["SEARCH_EMBEDDINGS is case-insensitive", { setting: " BuiltIn ", provider: "cloud", openAiKey: KEY }, "builtin", "SEARCH_EMBEDDINGS=builtin"],
  ];
  for (const [name, input, id, reason] of cases) {
    test(name, () => {
      const r = resolveSearchSpace(input);
      assert.equal(r.space.id, id);
      assert.equal(r.reason, reason);
    });
  }

  test("reports the normalised setting", () => {
    assert.equal(resolveSearchSpace({ provider: "cloud" }).setting, "auto");
    assert.equal(resolveSearchSpace({ setting: "OPENAI", provider: "cloud" }).setting, "openai");
  });
});

describe("the space registry", () => {
  test("OpenAI keeps the shipped calibration exactly", () => {
    const s = getSpace("openai");
    assert.equal(s.candidateFloor, CALIBRATION.candidateFloor);
    assert.equal(s.weakFieldThreshold, CALIBRATION.weakFieldThreshold);
    assert.equal(s.model, "text-embedding-3-small");
    assert.equal(s.dims, 512);
    assert.deepEqual(s.vectors, { kind: "inline" });
    assert.equal(s.queryPrefix, "");
  });

  test("built-in: nomic v1.5, 768 dims, in process, its own floor and vector file, nomic's task prefixes", () => {
    const s = getSpace("builtin");
    assert.equal(s.model, "nomic-embed-text-v1.5");
    assert.equal(s.dims, 768);
    assert.equal(s.backend, "inprocess");
    assert.equal(s.queryPrefix, "search_query: ");
    assert.equal(s.documentPrefix, "search_document: ");
    assert.deepEqual(s.vectors, { kind: "file", name: "nomic-embed-text-v1.5" });
    assert.ok(s.candidateFloor > getSpace("openai").candidateFloor, "nomic's cosines run higher, so its floor is higher");
    assert.equal(s.meterProvider, "builtin");
  });

  test("no space meters as OpenAI except OpenAI's own", () => {
    for (const s of Object.values(EMBEDDING_SPACES)) {
      assert.equal(s.meterProvider === "openai", s.id === "openai", s.id);
    }
  });

  test("every floor is a sensible cosine and every weak-field threshold at least 1", () => {
    for (const s of Object.values(EMBEDDING_SPACES)) {
      assert.ok(s.candidateFloor > 0 && s.candidateFloor < 1, s.id);
      assert.ok(s.weakFieldThreshold >= 1, s.id);
    }
  });
});

describe("a non-default OpenAI model or size is the custom space, at runtime and in data:embed alike", () => {
  test("EMBEDDINGS_MODEL other than text-embedding-3-small -> custom", () => {
    const r = resolveSearchSpace({ provider: "cloud", openAiKey: KEY, embeddingsModel: "text-embedding-3-large" });
    assert.equal(r.space.id, "custom");
    assert.equal(r.reason, "EMBEDDINGS_MODEL is set");
  });

  test("EMBEDDINGS_DIMENSIONS other than 512 -> custom", () => {
    assert.equal(resolveSearchSpace({ provider: "cloud", openAiKey: KEY, embeddingsDimensions: "1536" }).space.id, "custom");
  });

  test("the defaults spelled out explicitly are still the openai space", () => {
    const r = resolveSearchSpace({ provider: "cloud", openAiKey: KEY, embeddingsModel: "text-embedding-3-small", embeddingsDimensions: "512", embeddingsBaseUrl: "https://api.openai.com/v1" });
    assert.equal(r.space.id, "openai");
  });

  test("SEARCH_EMBEDDINGS=openai with a custom model -> custom (those settings say which OpenAI-compatible embedder)", () => {
    assert.equal(resolveSearchSpace({ setting: "openai", provider: "cloud", openAiKey: KEY, embeddingsModel: "text-embedding-3-large" }).space.id, "custom");
  });

  test("data:embed without --space follows the same rule", () => {
    assert.equal(customEmbedderFromEnv({ EMBEDDINGS_MODEL: "text-embedding-3-large" }), "EMBEDDINGS_MODEL is set");
    assert.equal(customEmbedderFromEnv({ EMBEDDINGS_BASE_URL: "http://localhost:11434/v1" }), "EMBEDDINGS_BASE_URL is set");
    assert.equal(customEmbedderFromEnv({}), null);
  });
});
