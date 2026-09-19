import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeOpenAiBaseUrl } from "../baseUrl";

test("normalizeOpenAiBaseUrl appends /v1 to a bare host", () => {
  assert.equal(normalizeOpenAiBaseUrl("http://localhost:11434"), "http://localhost:11434/v1");
  assert.equal(normalizeOpenAiBaseUrl("http://localhost:11434/"), "http://localhost:11434/v1");
  assert.equal(normalizeOpenAiBaseUrl("http://localhost:11434///"), "http://localhost:11434/v1");
});

test("normalizeOpenAiBaseUrl leaves a URL that already has a path untouched", () => {
  assert.equal(normalizeOpenAiBaseUrl("http://localhost:11434/v1"), "http://localhost:11434/v1");
  assert.equal(normalizeOpenAiBaseUrl("http://localhost:11434/v1/"), "http://localhost:11434/v1");
  assert.equal(normalizeOpenAiBaseUrl("http://localhost:1234/v1"), "http://localhost:1234/v1"); // LM Studio
  assert.equal(normalizeOpenAiBaseUrl("https://api.openai.com/v1"), "https://api.openai.com/v1");
  // A custom proxy path is NOT assumed to be /v1 — left as the user set it.
  assert.equal(normalizeOpenAiBaseUrl("https://proxy.example.com/openai"), "https://proxy.example.com/openai");
});

test("normalizeOpenAiBaseUrl handles empty/undefined and non-URLs safely", () => {
  assert.equal(normalizeOpenAiBaseUrl(""), "");
  assert.equal(normalizeOpenAiBaseUrl(undefined), "");
  assert.equal(normalizeOpenAiBaseUrl("   "), "");
  // Unparseable value is returned as-is (fetch will surface a clear error).
  assert.equal(normalizeOpenAiBaseUrl("not a url"), "not a url");
});
