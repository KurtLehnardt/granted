import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import React from "react";

import ModelSection, { draftOnProviderSwitch, type LlmProviderInfo } from "../ModelSection";
import type { OllamaStatus } from "@/lib/llm/ollamaModels";
import LocalModelPanel from "../LocalModelPanel";

/**
 * Settings' Local/Cloud switch. `initialInfo` is the hermetic test seam (no
 * network) — see ModelSection.tsx's doc comment.
 */
function render(initialInfo?: LlmProviderInfo) {
  return renderToStaticMarkup(React.createElement(ModelSection, { initialInfo }));
}

/** A GET /api/llm/ollama body: Ollama running with no models, on Windows, unless overridden. */
function ollamaStatus(over: Partial<OllamaStatus> = {}): OllamaStatus {
  return {
    installed: true,
    running: true,
    isOllama: true,
    host: "http://localhost:11434",
    canManage: true,
    platform: "win32",
    chatModels: [],
    embeddingModels: [],
    defaultModel: "gemma4:latest",
    configuredModel: "gemma4:latest",
    recommended: { model: "qwen2.5:7b", note: "Strong, well-calibrated local default for 16–32GB.", memGB: 31 },
    suggestions: ["qwen2.5:7b", "llama3.1:8b", "llama3.2:3b", "llama3.2:1b"],
    install: { auto: "winget", command: "winget install -e --id Ollama.Ollama", url: "https://ollama.com/download" },
    jobs: {},
    ...over,
  };
}

function renderLocal(over: Partial<OllamaStatus> = {}) {
  const ollama = ollamaStatus(over);
  return render({ provider: "ollama", local: true, model: ollama.defaultModel, models: ollama.chatModels, ollama });
}

const stateOf = (html: string) => /data-testid="local-setup" data-state="([a-z_]+)"/.exec(html)?.[1];

describe("ModelSection — Local says what's wrong and offers the fix", () => {
  test("not installed, Windows -> 'Install Ollama' button (winget, official installer fallback) and a download link", () => {
    const html = renderLocal({ installed: false, running: false, isOllama: false });
    assert.equal(stateOf(html), "not_installed");
    assert.match(html, /Ollama isn&#x27;t installed/);
    assert.match(html, />Install Ollama</);
    assert.match(html, /winget install -e --id Ollama\.Ollama/);
    assert.match(html, /official installer/);
    assert.match(html, /href="https:\/\/ollama\.com\/download"/);
    assert.match(html, />Check again</);
  });

  test("not installed, macOS/Linux -> a link and the install command, no install button", () => {
    const html = renderLocal({
      installed: false,
      running: false,
      isOllama: false,
      platform: "linux",
      install: { auto: null, command: "curl -fsSL https://ollama.com/install.sh | sh", url: "https://ollama.com/download" },
    });
    assert.equal(stateOf(html), "not_installed");
    assert.doesNotMatch(html, />Install Ollama</);
    assert.match(html, /Download Ollama from ollama\.com/);
    assert.match(html, /curl -fsSL https:\/\/ollama\.com\/install\.sh \| sh/);
  });

  test("install in progress -> progress line and bar", () => {
    const html = renderLocal({
      installed: false,
      running: false,
      isOllama: false,
      jobs: { install: { status: "running", pct: 40, message: "Downloading the Ollama installer: 40%" } },
    });
    assert.match(html, /Installing Ollama…/);
    assert.match(html, /Downloading the Ollama installer: 40%/);
    assert.match(html, /aria-valuenow="40"/);
  });

  test("installed but not running -> 'Start Ollama'", () => {
    const html = renderLocal({ running: false, isOllama: false });
    assert.equal(stateOf(html), "not_running");
    assert.match(html, /installed but isn&#x27;t running/);
    assert.match(html, />Start Ollama</);
    assert.match(html, />Check again</);
  });

  test("a start that failed shows why", () => {
    const html = renderLocal({ running: false, isOllama: false, jobs: { start: { status: "error", error: "Ollama didn't start within 90 seconds." } } });
    assert.match(html, /didn&#x27;t start within 90 seconds/);
  });

  test("running, only an embedding model -> no picker, 'Download a model' with the recommended tier and alternatives", () => {
    const html = renderLocal({ embeddingModels: ["nomic-embed-text:latest"] });
    assert.equal(stateOf(html), "no_chat_models");
    assert.doesNotMatch(html, /Local model<\/label>/);
    assert.match(html, /nomic-embed-text:latest is an embedding model and can&#x27;t run searches/);
    assert.match(html, /Download a model/);
    assert.match(html, /Recommended for this computer \(31 GB of memory\)/);
    assert.match(html, />Download qwen2\.5:7b \(recommended\)</);
    assert.match(html, />Download llama3\.1:8b</);
    assert.doesNotMatch(html, /<option[^>]*>nomic-embed-text/);
  });

  test("the user's report: configured gemma4:latest isn't installed -> Default shows and runs an installed model, says so, offers to download it", () => {
    const html = renderLocal({
      chatModels: [{ name: "qwen2.5:7b", paramsB: 7.6 }, { name: "llama3.2:1b", paramsB: 1.2 }],
      embeddingModels: ["nomic-embed-text:latest"],
      defaultModel: "qwen2.5:7b", // resolved by the server: the best installed chat model
      configuredModel: "gemma4:latest",
    });
    assert.equal(stateOf(html), "ok");
    assert.match(html, /<option value="" selected="">Default \(qwen2\.5:7b\)<\/option>/);
    assert.doesNotMatch(html, /Default \(gemma4/);
    assert.match(html, /The configured default, gemma4:latest, isn&#x27;t installed, so Default uses qwen2\.5:7b/);
    assert.match(html, /<option value="llama3\.2:1b">llama3\.2:1b \(1\.2B\)<\/option>/);
    assert.match(html, />Download gemma4:latest</);
    assert.doesNotMatch(html, />Download qwen2\.5:7b/);
    assert.doesNotMatch(html, /<option[^>]*>nomic-embed-text/);
  });

  test("a picked model that's no longer installed falls back to Default, never a model_missing dead end", () => {
    const html = render({
      provider: "ollama",
      local: true,
      ollama: ollamaStatus({ chatModels: [{ name: "llama3.2:1b" }], defaultModel: "llama3.2:1b" }),
    });
    assert.equal(stateOf(html), "ok");
  });

  test("pull in progress -> progress and the download buttons disabled", () => {
    const html = renderLocal({ jobs: { pull: { status: "running", model: "qwen2.5:7b", pct: 37, message: "Downloading qwen2.5:7b: 1.7 GB of 4.7 GB" } } });
    assert.match(html, /Downloading qwen2\.5:7b: 1\.7 GB of 4\.7 GB/);
    assert.match(html, /aria-valuenow="37"/);
    assert.match(html, /<button type="button"[^>]*disabled=""[^>]*>Download qwen2\.5:7b/);
  });

  test("ok -> the picker, no warnings, no download section", () => {
    const html = renderLocal({ chatModels: [{ name: "gemma4:latest", paramsB: 4 }, { name: "qwen2.5:7b", paramsB: 7 }] });
    assert.equal(stateOf(html), "ok");
    assert.match(html, /Runs on your own machine via Ollama/);
    assert.match(html, /Local model/);
    assert.doesNotMatch(html, /not installed/);
    assert.doesNotMatch(html, /Download a model/);
    assert.match(html, />Check again</);
  });

  test("a pick that's no longer installed -> 'Your pick X isn't installed; using Y'", () => {
    const ollama = ollamaStatus({ chatModels: [{ name: "qwen2.5:7b" }], defaultModel: "qwen2.5:7b" });
    const html = renderToStaticMarkup(
      React.createElement(LocalModelPanel, { initialStatus: ollama, selectedModel: "gone:3b", onSelectModel: () => {} }),
    );
    assert.match(html, /data-testid="local-pick-notice"[^>]*>Your pick gone:3b isn&#x27;t installed; using qwen2\.5:7b\.</);
  });

  test("a running download or install has a Cancel button", () => {
    const pulling = renderLocal({ jobs: { pull: { status: "running", model: "qwen2.5:7b", pct: 5, message: "Downloading" } } });
    assert.match(pulling, /data-testid="local-pull-progress"[\s\S]*>Cancel</);
    const installing = renderLocal({ installed: false, running: false, isOllama: false, jobs: { install: { status: "running", message: "winget: …" } } });
    assert.match(installing, /data-testid="local-install-progress"[\s\S]*>Cancel</);
    const cancelled = renderLocal({ jobs: { pull: { status: "error", model: "qwen2.5:7b", error: "Cancelled." } } });
    assert.match(cancelled, />Cancelled\.</);
    assert.doesNotMatch(cancelled, />Cancel</);
  });

  test("a local server that isn't Ollama is down -> names the server; no Start or Install Ollama", () => {
    const html = renderLocal({ host: "http://127.0.0.1:1234", canManage: false, running: false, isOllama: false, install: { auto: null, command: "x", url: "https://ollama.com/download" } });
    assert.equal(stateOf(html), "not_running");
    assert.match(html, /Couldn&#x27;t reach the local model server at http:\/\/127\.0\.0\.1:1234/);
    assert.doesNotMatch(html, />Start Ollama</);
    assert.doesNotMatch(html, />Install Ollama</);
  });

  test("no status yet -> 'Checking Ollama…', never a blank panel", () => {
    const html = render({ provider: "ollama", local: true });
    assert.match(html, /Checking Ollama…/);
  });
});

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
    const models = [{ name: "gemma4:latest", paramsB: 4 }, { name: "qwen2.5:7b", paramsB: 7 }];
    const html = render({
      provider: "ollama",
      local: true,
      model: "gemma4:latest",
      models,
      ollama: ollamaStatus({ chatModels: models }),
    });
    assert.match(html, /Local model/);
    assert.match(html, /qwen2\.5:7b/);
  });

  test("provider: ollama never sends the user to the README/terminal for embeddings any more", () => {
    const html = render({ provider: "ollama", local: true });
    assert.doesNotMatch(html, /run on Local until embeddings/);
    assert.doesNotMatch(html, /README/);
  });

  test("the Search line shows on Local and on Cloud, with the built-in model's state", () => {
    const builtin = (state: "ready" | "downloading" | "failed", extra = {}) => ({
      space: "builtin" as const,
      label: "Built-in, on this computer",
      model: "nomic-embed-text-v1.5",
      reason: "Local model selected",
      setting: "auto" as const,
      builtin: { state, model: "nomic-embed-text-v1.5", totalBytes: 274574153, ...extra },
    });
    const downloading = render({ provider: "ollama", local: true, search: builtin("downloading", { pct: 30 }) });
    assert.match(downloading, /search-status/);
    assert.match(downloading, /Downloading the search model: 30%/);

    const failed = render({ provider: "ollama", local: true, search: builtin("failed", { error: "offline" }) });
    assert.match(failed, />Retry</);

    const cloud = render({ provider: "cloud", local: false, search: builtin("ready") });
    assert.match(cloud, /Search: Built-in, on this computer/);

    const openai = render({
      provider: "cloud",
      local: false,
      search: { ...builtin("ready"), space: "openai", label: "OpenAI embeddings", model: "text-embedding-3-small" },
    });
    assert.match(openai, /Search: OpenAI embeddings/);
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
