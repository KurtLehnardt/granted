import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import React from "react";

import ModelSection, { type LlmProviderInfo } from "../ModelSection";

/**
 * Settings' Local/Cloud switch. `initialInfo` is the hermetic test seam (no
 * network) — see ModelSection.tsx's doc comment.
 */
function render(initialInfo?: LlmProviderInfo) {
  return renderToStaticMarkup(React.createElement(ModelSection, { initialInfo }));
}

describe("ModelSection — renders the right panel per provider", () => {
  test("provider: ollama -> local panel, no key inputs, toggle says 'Cloud' (not 'Claude')", () => {
    const html = render({ provider: "ollama", local: true });
    assert.match(html, /Local \(Ollama\)/);
    assert.match(html, /model-panel-local/);
    assert.doesNotMatch(html, /model-panel-cloud/);
    assert.doesNotMatch(html, /Claude/);
    assert.match(html, />\s*Cloud\s*</);
  });

  test("provider: ollama with installed models -> renders the model picker", () => {
    const html = render({
      provider: "ollama",
      local: true,
      model: "gemma4:latest",
      models: [{ name: "gemma4:latest", paramsB: 4 }, { name: "qwen2.5:7b", paramsB: 7 }],
    });
    assert.match(html, /Local model/);
    assert.match(html, /qwen2\.5:7b/);
  });

  test("provider: ollama with OpenAI embeddings -> warns searches won't run", () => {
    assert.match(render({ provider: "ollama", local: true, openAiEmbeddings: true }), /run on Local until embeddings/);
    assert.doesNotMatch(render({ provider: "ollama", local: true, openAiEmbeddings: false }), /run on Local until embeddings/);
  });

  test("provider: cloud, no key -> cloud panel with a provider select covering every preset", () => {
    const html = render({ provider: "cloud", local: false });
    assert.match(html, /model-panel-cloud/);
    assert.doesNotMatch(html, /model-panel-local/);
    for (const label of ["Anthropic (Claude)", "OpenAI", "Google Gemini", "OpenRouter", "Groq", "Mistral", "Other (OpenAI-compatible)"]) {
      assert.match(html, new RegExp(label.replace(/[()]/g, "\\$&")));
    }
    assert.doesNotMatch(html, /cloud-key-status/);
  });

  test("provider: cloud, anthropic key saved -> shows masked hint status line", () => {
    const html = render({
      provider: "cloud",
      local: false,
      cloud: { providerId: "anthropic", hasKey: true, keyHint: "abcd", keySource: { type: "inline" } },
    });
    assert.match(html, /cloud-key-status/);
    assert.match(html, /Key saved/);
    assert.match(html, /abcd/);
  });

  test("provider: cloud, key from an env var -> shows the variable name, not a value", () => {
    const html = render({
      provider: "cloud",
      local: false,
      cloud: { providerId: "openai", hasKey: true, keySource: { type: "env", name: "OPENAI_API_KEY" } },
    });
    assert.match(html, /OPENAI_API_KEY/);
    assert.doesNotMatch(html, /type="password"[^>]*value="[^"]+"/);
  });

  test("provider: cloud, key from a file -> shows the path, not a value", () => {
    const html = render({
      provider: "cloud",
      local: false,
      cloud: { providerId: "mistral", hasKey: true, keySource: { type: "file", path: "/etc/granted/mistral.key" } },
    });
    assert.match(html, /\/etc\/granted\/mistral\.key/);
  });

  test("'other' provider shows a base URL field; presets don't", () => {
    const other = render({ provider: "cloud", local: false, cloud: { providerId: "other", hasKey: false, keySource: { type: "inline" } } });
    assert.match(other, /Base URL/);

    const openai = render({ provider: "cloud", local: false, cloud: { providerId: "openai", hasKey: false, keySource: { type: "inline" } } });
    assert.doesNotMatch(openai, /Base URL/);
  });

  test("saved model is reflected in the model field's value", () => {
    const html = render({
      provider: "cloud",
      local: false,
      cloud: { providerId: "openai", model: "gpt-4o", hasKey: true, keyHint: "0000", keySource: { type: "inline" } },
    });
    assert.match(html, /value="gpt-4o"/);
  });

  test("never renders a raw key value anywhere in the markup", () => {
    const html = render({
      provider: "cloud",
      local: false,
      cloud: { providerId: "anthropic", hasKey: true, keyHint: "7890", keySource: { type: "inline" } },
    });
    assert.doesNotMatch(html, /sk-ant-[A-Za-z0-9_-]{10,}/);
  });

  test("Save and Test key controls are present on the cloud panel", () => {
    const html = render({ provider: "cloud", local: false });
    assert.match(html, /Save/);
    assert.match(html, /Test key/);
  });
});
