import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import React from "react";
import LocalModelPanel from "../LocalModelPanel";
import ModelSection from "../ModelSection";
import type { OllamaStatus } from "@/lib/llm/ollamaModels";

function status(over: Partial<OllamaStatus> = {}): OllamaStatus {
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
    recommended: { model: "qwen2.5:7b", note: "", memGB: 31 },
    suggestions: ["qwen2.5:7b"],
    install: { auto: "winget", command: "winget install -e --id Ollama.Ollama", url: "https://ollama.com/download" },
    jobs: {},
    ...over,
  };
}
const render = (s: OllamaStatus) =>
  renderToStaticMarkup(React.createElement(LocalModelPanel, { initialStatus: s, selectedModel: null, onSelectModel: () => {} }));

describe("Settings → Model → Local: Report this problem", () => {
  test("a download that failed shows its Error ID and the report link", () => {
    const html = render(status({ jobs: { pull: { status: "error", model: "qwen2.5:7b", error: "The download stopped before it finished.", errorId: "E-PQRSTU" } } }));
    assert.match(html, /The download stopped before it finished\./);
    assert.match(html, /E-PQRSTU/);
    assert.match(html, />Report this problem</);
  });

  test("an install or start that failed too", () => {
    for (const jobs of [
      { install: { status: "error" as const, error: "winget failed.", errorId: "E-ABCDEF" } },
      { start: { status: "error" as const, error: "Ollama didn't start within 90 seconds.", errorId: "E-GHJKLM" } },
    ]) {
      const html = render(status({ installed: !("install" in jobs), running: false, isOllama: false, jobs }));
      assert.match(html, />Report this problem</, JSON.stringify(jobs));
    }
  });

  test("a cancel isn't a problem: no report link", () => {
    const html = render(status({ jobs: { pull: { status: "error", model: "qwen2.5:7b", error: "Cancelled." } } }));
    assert.match(html, />Cancelled\.</);
    assert.doesNotMatch(html, /Report this problem/);
  });

  test("setup states the user fixes (not installed, not running, no chat model) are guidance: no report link", () => {
    for (const s of [
      status({ installed: false, running: false, isOllama: false }),
      status({ running: false, isOllama: false }),
      status({ embeddingModels: ["nomic-embed-text"] }),
    ]) {
      assert.doesNotMatch(render(s), /Report this problem|Error ID/);
    }
  });

  test("ModelSection itself shows no report link while nothing has failed", () => {
    const ollama = status({ chatModels: [{ name: "qwen2.5:7b", paramsB: 7 }] as OllamaStatus["chatModels"] });
    const html = renderToStaticMarkup(
      React.createElement(ModelSection, { initialInfo: { provider: "ollama", local: true, model: "qwen2.5:7b", models: ollama.chatModels, ollama } as never }),
    );
    assert.doesNotMatch(html, /Report this problem/);
  });
});
