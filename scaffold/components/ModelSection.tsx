"use client";

import React, { useEffect, useId, useState } from "react";
import { getModel, setModel } from "@/lib/searchSettings";
import type { OllamaModel } from "@/lib/llm/ollamaInfo";

export type LlmProviderInfo = {
  provider: "ollama" | "anthropic";
  local: boolean;
  hasAnthropicKey: boolean;
  anthropicKeyHint?: string;
  model?: string;
  models?: OllamaModel[];
};

/**
 * Settings' "Model" section: the Local (Ollama) / Cloud (Claude) switch.
 *
 * Extracted from SettingsForm as its own component (like SearchProgress /
 * IntakeForm split elsewhere) so it's a hermetic renderToStaticMarkup test
 * seam — `initialInfo` lets a test render either panel with no network call.
 * Outside tests it fetches GET /api/llm itself on mount.
 *
 * Provider switches and key changes apply immediately via POST
 * /api/llm/config (loopback-only) — there's no separate "Save" for this
 * section, since a stale server-side provider would silently keep sending
 * searches to the wrong backend.
 */
export default function ModelSection({ initialInfo }: { initialInfo?: LlmProviderInfo }) {
  const uid = useId();
  const modelId = `${uid}-model`;
  const apiKeyId = `${uid}-api-key`;

  const [info, setInfo] = useState<LlmProviderInfo | null>(initialInfo ?? null);
  const [model, setModelState] = useState<string | null>(() => getModel());
  const [keyDraft, setKeyDraft] = useState("");
  const [replacing, setReplacing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; error?: string } | null>(null);

  async function refresh() {
    try {
      const res = await fetch("/api/llm");
      if (res.ok) setInfo(await res.json());
    } catch {
      /* offline / unreachable — keep the last known info showing */
    }
  }

  useEffect(() => {
    if (!initialInfo) refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function switchProvider(provider: "ollama" | "anthropic") {
    if (provider === info?.provider) return;
    setError(null);
    setTestResult(null);
    if (provider === "anthropic" && !info?.hasAnthropicKey) {
      // No key yet — just reveal the Cloud panel so the user can add one;
      // saving the key (below) is what actually switches the provider.
      setInfo((i) => (i ? { ...i, provider } : { provider, local: false, hasAnthropicKey: false }));
      setReplacing(true);
      return;
    }
    await postConfig({ provider });
  }

  async function postConfig(body: Record<string, unknown>): Promise<boolean> {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/llm/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(json?.error ?? `HTTP ${res.status}`);
        return false;
      }
      await refresh();
      return true;
    } catch {
      setError("Couldn't reach the server. Try again.");
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function handleSaveKey() {
    const key = keyDraft.trim();
    if (!key) {
      setError("Enter an API key.");
      return;
    }
    const ok = await postConfig({ provider: "anthropic", anthropicApiKey: key });
    if (ok) {
      setKeyDraft("");
      setReplacing(false);
    }
  }

  async function handleRemoveKey() {
    await postConfig({ provider: info?.provider ?? "anthropic", clearAnthropicKey: true });
  }

  async function handleTestKey() {
    setTesting(true);
    setTestResult(null);
    try {
      const key = keyDraft.trim();
      const res = await fetch("/api/llm/test-key", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(key ? { anthropicApiKey: key } : {}),
      });
      const json = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
      setTestResult(json);
    } catch {
      setTestResult({ ok: false, error: "Couldn't reach the server." });
    } finally {
      setTesting(false);
    }
  }

  const legendClass = "font-mono text-[11px] uppercase tracking-eyebrow text-foreground";
  const fieldWrapClass =
    "mt-5 border-t border-structure-on-canvas pt-4 first:mt-4 first:border-t-0 first:pt-0";
  const inputClass =
    "mt-1.5 w-full rounded-sm border border-structure-on-canvas bg-canvas px-2.5 py-1.5 font-body text-[13px] text-foreground outline-none transition focus:border-structure-on-canvas focus:ring-2 focus:ring-structure-on-canvas";
  const labelTextClass = "font-body text-[13px] text-foreground";
  const smallBtnClass =
    "inline-flex min-h-[36px] items-center rounded-sm border border-structure-on-canvas px-3 py-1.5 font-mono text-[11px] uppercase tracking-eyebrow text-structure-on-canvas transition hover:bg-structure hover:text-token-white disabled:opacity-50";
  const segBtnClass = (active: boolean) =>
    `flex-1 min-h-[40px] rounded-sm border border-structure-on-canvas px-3 py-1.5 font-mono text-[11px] uppercase tracking-eyebrow transition ${
      active ? "bg-structure text-token-white" : "bg-canvas text-structure-on-canvas hover:bg-canvas-alt"
    }`;

  const provider = info?.provider ?? "ollama";
  const localModels = info?.models ?? null;

  return (
    <div className={fieldWrapClass} data-testid="model-section">
      <span className={legendClass}>Model</span>
      <div className="mt-2 flex gap-2" role="group" aria-label="LLM provider">
        <button
          type="button"
          className={segBtnClass(provider === "ollama")}
          aria-pressed={provider === "ollama"}
          disabled={saving}
          onClick={() => switchProvider("ollama")}
        >
          Local (Ollama)
        </button>
        <button
          type="button"
          className={segBtnClass(provider === "anthropic")}
          aria-pressed={provider === "anthropic"}
          disabled={saving}
          onClick={() => switchProvider("anthropic")}
        >
          Cloud (Claude)
        </button>
      </div>

      {provider === "ollama" && (
        <div data-testid="model-panel-local" className="mt-3">
          {localModels && localModels.length > 0 ? (
            <>
              <label className={legendClass} htmlFor={modelId}>
                Local model
              </label>
              <select
                id={modelId}
                value={model ?? ""}
                onChange={(e) => {
                  const v = e.target.value || null;
                  setModelState(v);
                  setModel(v);
                }}
                className={inputClass}
              >
                <option value="">Default{info?.model ? ` (${info.model})` : ""}</option>
                {localModels.map((m) => (
                  <option key={m.name} value={m.name}>
                    {m.name}
                    {m.paramsB != null ? ` (${m.paramsB}B)` : ""}
                  </option>
                ))}
              </select>
              <p className="mt-1.5 font-body text-[12px] text-foreground opacity-80">
                Which installed Ollama model runs your search. Larger models are more capable but
                slower.
              </p>
            </>
          ) : (
            <p className="font-body text-[12px] text-foreground opacity-80">
              Runs on your own machine via Ollama — nothing leaves your computer.
            </p>
          )}
        </div>
      )}

      {provider === "anthropic" && (
        <div data-testid="model-panel-cloud" className="mt-3">
          {info?.hasAnthropicKey && !replacing ? (
            <div className="flex flex-wrap items-center gap-2">
              <span className={labelTextClass}>
                Key saved &bull;&bull;&bull;&bull;{info.anthropicKeyHint ?? ""}
              </span>
              <button type="button" className={smallBtnClass} onClick={() => setReplacing(true)}>
                Replace
              </button>
              <button type="button" className={smallBtnClass} onClick={handleRemoveKey} disabled={saving}>
                Remove
              </button>
            </div>
          ) : (
            <>
              <label className={legendClass} htmlFor={apiKeyId}>
                Anthropic API key
              </label>
              <input
                id={apiKeyId}
                type="password"
                value={keyDraft}
                onChange={(e) => setKeyDraft(e.target.value)}
                placeholder="sk-ant-..."
                className={inputClass}
                autoComplete="off"
              />
              <div className="mt-2 flex flex-wrap gap-2">
                <button type="button" className={smallBtnClass} onClick={handleSaveKey} disabled={saving}>
                  Save key
                </button>
                {info?.hasAnthropicKey && (
                  <button
                    type="button"
                    className={smallBtnClass}
                    onClick={() => {
                      setReplacing(false);
                      setKeyDraft("");
                    }}
                  >
                    Cancel
                  </button>
                )}
              </div>
            </>
          )}
          <div className="mt-2 flex items-center gap-2">
            <button type="button" className={smallBtnClass} onClick={handleTestKey} disabled={testing}>
              {testing ? "Testing…" : "Test key"}
            </button>
            {testResult && (
              <span className="font-body text-[12px] text-foreground">
                {testResult.ok ? "Key works." : testResult.error ?? "Test failed."}
              </span>
            )}
          </div>
        </div>
      )}

      {error && (
        <p className="mt-2 rounded-r-sm border-l-2 border-error bg-canvas-alt px-3 py-2 font-body text-[12px] text-foreground">
          {error}
        </p>
      )}
    </div>
  );
}
