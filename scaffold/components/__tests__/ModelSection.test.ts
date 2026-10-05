import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import React from "react";

import ModelSection, { draftOnProviderSwitch, type LlmProviderInfo } from "../ModelSection";

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

  test("provider: ollama never sends the user to the README/terminal for embeddings any more", () => {
    const html = render({ provider: "ollama", local: true });
    assert.doesNotMatch(html, /run on Local until embeddings/);
    assert.doesNotMatch(html, /README/);
  });

  test("provider: ollama shows the local search setup status (progress / error + Retry / ready)", () => {
    const running = render({
      provider: "ollama",
      local: true,
      localEmbeddings: { state: "running", model: "nomic-embed-text", active: false, progress: { stage: "pulling", pct: 30 } },
    });
    assert.match(running, /local-search-status/);
    assert.match(running, /Downloading the local search model \(nomic-embed-text\): 30%/);

    const failed = render({
      provider: "ollama",
      local: true,
      localEmbeddings: { state: "failed", model: "nomic-embed-text", active: false, error: "Couldn't reach Ollama" },
    });
    assert.match(failed, />Retry</);

    const ready = render({
      provider: "ollama",
      local: true,
      localEmbeddings: { state: "ready", model: "nomic-embed-text", active: true, count: 12 },
    });
    assert.match(ready, /Search runs on this machine/);
  });

  test("provider: cloud never shows the local search status", () => {
    const html = render({
      provider: "cloud",
      local: false,
      localEmbeddings: { state: "running", model: "nomic-embed-text", active: false, progress: { stage: "checking" } },
    });
    assert.doesNotMatch(html, /local-search-status/);
  });

  test("provider: cloud, no key -> cloud panel with a provider select covering every preset", () => {
    const html = render({ provider: "cloud", local: false });
    assert.match(html, /model-panel-cloud/);
    assert.doesNotMatch(html, /model-panel-local/);
    for (const label of [
      "Anthropic (Claude)",
      "OpenAI",
      "Google Gemini",
      "OpenRouter",
      "Groq",
      "Mistral",
      "Anthropic-compatible proxy (e.g. Free Claude Code)",
      "Other (OpenAI-compatible)",
    ]) {
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

  test("Remove control is present on the cloud panel", () => {
    assert.match(render({ provider: "cloud", local: false }), />\s*Remove\s*</);
  });

  test("REGRESSION (review): a key from .env.local has no Remove (it'd just come back) — it says where to change it", () => {
    const html = render({
      provider: "cloud",
      local: false,
      cloud: { providerId: "openai", hasKey: true, keyHint: "abcd", keySource: { type: "env", name: "OPENAI_API_KEY" }, fromEnv: true },
    });
    assert.doesNotMatch(html, />\s*Remove\s*</);
    assert.match(html, /data-testid="cloud-from-env"/);
    assert.match(html, /From OPENAI_API_KEY in[\s\S]*\.env\.local/);
  });

  test("active-provider indicator reports the server's provider, not just which panel is open", () => {
    // Server is on ollama — even a render where the initial panel would be
    // cloud (a saved cloud config exists) must still say the active provider
    // is Local, never "Cloud", since only Save (never merely opening the
    // panel) can change what's active.
    const html = render({
      provider: "ollama",
      local: true,
      cloud: { providerId: "openai", hasKey: true, keyHint: "0000", keySource: { type: "inline" } },
    });
    assert.match(html, /active-provider/);
    assert.match(html, /Active:\s*Local/);
    assert.doesNotMatch(html, /Active:\s*Cloud/);
  });

  test("active-provider indicator names the active cloud provider", () => {
    const html = render({
      provider: "cloud",
      local: false,
      cloud: { providerId: "groq", hasKey: true, keyHint: "0000", keySource: { type: "inline" } },
    });
    assert.match(html, /Active:\s*Cloud \(Groq\)/);
  });

  test("model field is marked required for a provider with no default (openrouter), not for one with a default (openai)", () => {
    const openrouter = render({ provider: "cloud", local: false, cloud: { providerId: "openrouter", hasKey: false, keySource: { type: "inline" } } });
    assert.match(openrouter, /Model \(required\)/);

    const openai = render({ provider: "cloud", local: false, cloud: { providerId: "openai", hasKey: false, keySource: { type: "inline" } } });
    assert.doesNotMatch(openai, /Model \(required\)/);
  });

  test("model field is not marked required for anthropic, despite having no default", () => {
    const html = render({ provider: "cloud", local: false, cloud: { providerId: "anthropic", hasKey: false, keySource: { type: "inline" } } });
    assert.doesNotMatch(html, /Model \(required\)/);
  });

  test("cloud key input has an accessible info tooltip: keyboard-focusable button, aria-describedby wired to the tooltip text", () => {
    const html = render({ provider: "cloud", local: false, cloud: { providerId: "anthropic", hasKey: false, keySource: { type: "inline" } } });
    // A real <button>, not a bare span — reachable by keyboard/Tab by default.
    assert.match(html, /<button[^>]*aria-label="Key requirements"[^>]*>/);
    // The tooltip text itself, and it's exactly what the owner's testing specified.
    assert.match(html, /Please ensure your key is valid, has the correct permissions, and is scoped to the correct workspace\./);
    // The key <input> is associated with that tooltip text via aria-describedby.
    const inputMatch = html.match(/<input[^>]*id="[^"]*-key-value"[^>]*>/);
    assert.ok(inputMatch, "key input not found");
    const describedByMatch = inputMatch![0].match(/aria-describedby="([^"]+)"/);
    assert.ok(describedByMatch, "key input has no aria-describedby");
    const tooltipId = describedByMatch![1];
    assert.match(html, new RegExp(`id="${tooltipId}"[^>]*role="tooltip"`));
  });

  test("fcc: shows an editable base URL field and its privacy note", () => {
    const html = render({
      provider: "cloud",
      local: false,
      cloud: { providerId: "fcc", baseUrl: "http://127.0.0.1:8082", hasKey: false, keySource: { type: "file", path: "~/.fcc/proxy_auth_token" } },
    });
    assert.match(html, /Base URL/);
    assert.match(html, /value="http:\/\/127\.0\.0\.1:8082"/);
    assert.match(html, /cloud-privacy-note/);
    assert.match(html, /Prompts are forwarded to third-party free providers, which may log them\./);
  });

  test("privacy note is absent for a preset with none (e.g. openai)", () => {
    const html = render({ provider: "cloud", local: false, cloud: { providerId: "openai", hasKey: false, keySource: { type: "inline" } } });
    assert.doesNotMatch(html, /cloud-privacy-note/);
  });

  test("fcc: not marked required (has a default model) and shows the secret-file path", () => {
    const html = render({
      provider: "cloud",
      local: false,
      cloud: { providerId: "fcc", hasKey: true, keySource: { type: "file", path: "~/.fcc/proxy_auth_token" } },
    });
    assert.doesNotMatch(html, /Model \(required\)/);
    assert.match(html, /~\/\.fcc\/proxy_auth_token/);
  });

  test("a saved inline key never reprefills the draft field, but its placeholder says the key is kept if left blank", () => {
    const html = render({
      provider: "cloud",
      local: false,
      cloud: { providerId: "openai", hasKey: true, keyHint: "0000", keySource: { type: "inline" } },
    });
    assert.match(html, /Leave blank to keep the saved key/);
  });
});

describe("draftOnProviderSwitch", () => {
  const onAnthropic = { providerId: "anthropic" as const, keySourceType: "inline" as const, filePath: "" };
  const onFccDefault = { providerId: "fcc" as const, keySourceType: "file" as const, filePath: "~/.fcc/proxy_auth_token" };

  test("to fcc: prefills its default base URL and token file", () => {
    assert.deepEqual(draftOnProviderSwitch("fcc", undefined, onAnthropic), {
      baseUrl: "http://127.0.0.1:8082",
      keySource: { type: "file", path: "~/.fcc/proxy_auth_token" },
    });
  });

  test("away from fcc: its untouched token file isn't carried to another provider", () => {
    assert.deepEqual(draftOnProviderSwitch("groq", undefined, onFccDefault), { baseUrl: "", keySource: { type: "inline" } });
  });

  test("away from fcc with a user-edited file path: key source is left alone", () => {
    assert.deepEqual(draftOnProviderSwitch("groq", undefined, { ...onFccDefault, filePath: "/keys/groq.key" }), { baseUrl: "" });
  });

  test("back to the saved provider: its saved base URL and key source are restored", () => {
    const saved = { providerId: "other" as const, baseUrl: "https://llm.example.com/v1", hasKey: true, keySource: { type: "env" as const, name: "MY_KEY" } };
    assert.deepEqual(draftOnProviderSwitch("other", saved, onAnthropic), { baseUrl: "https://llm.example.com/v1", keySource: { type: "env", name: "MY_KEY" } });
  });
});
