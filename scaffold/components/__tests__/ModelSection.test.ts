import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import React from "react";

import ModelSection from "../ModelSection";

/**
 * Settings' Local/Cloud switch. `initialInfo` is the hermetic test seam (no
 * network) — see ModelSection.tsx's doc comment.
 */
function render(initialInfo?: React.ComponentProps<typeof ModelSection>["initialInfo"]) {
  return renderToStaticMarkup(React.createElement(ModelSection, { initialInfo }));
}

describe("ModelSection — renders the right panel per provider", () => {
  test("provider: ollama -> local panel, no API key input", () => {
    const html = render({ provider: "ollama", local: true, hasAnthropicKey: false });
    assert.match(html, /Local \(Ollama\)/);
    assert.match(html, /model-panel-local/);
    assert.doesNotMatch(html, /model-panel-cloud/);
    assert.doesNotMatch(html, /type="password"/);
  });

  test("provider: ollama with installed models -> renders the model picker", () => {
    const html = render({
      provider: "ollama",
      local: true,
      hasAnthropicKey: false,
      model: "gemma4:latest",
      models: [{ name: "gemma4:latest", paramsB: 4 }, { name: "qwen2.5:7b", paramsB: 7 }],
    });
    assert.match(html, /Local model/);
    assert.match(html, /qwen2\.5:7b/);
  });

  test("provider: ollama with OpenAI embeddings -> warns searches won't run", () => {
    assert.match(render({ provider: "ollama", local: true, hasAnthropicKey: false, openAiEmbeddings: true }), /EMBEDDINGS_BASE_URL/);
    assert.doesNotMatch(render({ provider: "ollama", local: true, hasAnthropicKey: false, openAiEmbeddings: false }), /EMBEDDINGS_BASE_URL/);
  });

  test("provider: anthropic, no key -> cloud panel with a password input", () => {
    const html = render({ provider: "anthropic", local: false, hasAnthropicKey: false });
    assert.match(html, /Cloud \(Claude\)/);
    assert.match(html, /model-panel-cloud/);
    assert.match(html, /type="password"/);
    assert.doesNotMatch(html, /model-panel-local/);
  });

  test("provider: anthropic, key saved -> shows masked hint + Replace/Remove, no raw key", () => {
    const html = render({ provider: "anthropic", local: false, hasAnthropicKey: true, anthropicKeyHint: "abcd" });
    assert.match(html, /Key saved/);
    assert.match(html, /abcd/);
    assert.match(html, /Replace/);
    assert.match(html, /Remove/);
    assert.doesNotMatch(html, /type="password"/);
  });

  test("provider: anthropic, key from env -> shows .env.local notice, Replace but no Remove", () => {
    const html = render({
      provider: "anthropic",
      local: false,
      hasAnthropicKey: true,
      anthropicKeySource: "env",
    });
    assert.match(html, /Using key from \.env\.local/);
    assert.match(html, /Replace/);
    assert.doesNotMatch(html, /Remove/);
  });

  test("Test key button is always present on the cloud panel", () => {
    const html = render({ provider: "anthropic", local: false, hasAnthropicKey: true, anthropicKeyHint: "abcd" });
    assert.match(html, /Test key/);
  });
});
