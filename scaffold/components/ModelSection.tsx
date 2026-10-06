"use client";

import React, { useEffect, useId, useState } from "react";
import { getModel, setModel } from "@/lib/searchSettings";
import type { OllamaModel } from "@/lib/llm/ollamaInfo";
import { CLOUD_PROVIDERS, isSameCloudTarget, type CloudProviderId } from "@/lib/llm/providers";
import type { SearchStatus } from "@/lib/embeddings/searchStatus";
import LocalSearchStatus from "@/components/LocalSearchStatus";

export type KeySourceType = "inline" | "env" | "file";
export type PublicKeySource = { type: "inline" } | { type: "env"; name: string } | { type: "file"; path: string };

export type CloudInfo = {
  providerId: CloudProviderId;
  baseUrl?: string;
  model?: string;
  hasKey: boolean;
  keyHint?: string;
  keySource: PublicKeySource;
  /** From ANTHROPIC_API_KEY / OPENAI_API_KEY in .env.local rather than saved here — can't be removed from Settings. */
  fromEnv?: boolean;
};

const KEY_TOOLTIP_TEXT =
  "Please ensure your key is valid, has the correct permissions, and is scoped to the correct workspace.";

/**
 * Accessible "ⓘ" tooltip for the cloud key input: a keyboard-focusable button
 * (not a bare span) whose tooltip text shows on hover AND focus, and whose id
 * the caller wires to the key input's `aria-describedby` so screen-reader
 * users get the same hint reading the field itself, not only the icon.
 */
function KeyInfoTooltip({ id }: { id: string }) {
  const [visible, setVisible] = useState(false);
  return (
    <span
      className="relative ml-1 inline-block align-middle"
      onMouseEnter={() => setVisible(true)}
      onMouseLeave={() => setVisible(false)}
    >
      <button
        type="button"
        aria-describedby={id}
        aria-label="Key requirements"
        className="inline-flex h-3.5 w-3.5 cursor-help select-none items-center justify-center rounded-full border border-structure-on-canvas font-mono text-[9px] leading-none text-structure-on-canvas outline-none focus-visible:ring-2 focus-visible:ring-structure-on-canvas"
        onFocus={() => setVisible(true)}
        onBlur={() => setVisible(false)}
        onKeyDown={(e) => {
          if (e.key === "Escape") setVisible(false);
        }}
      >
        ⓘ
      </button>
      <span
        id={id}
        role="tooltip"
        className={`absolute left-1/2 top-full z-10 w-56 -translate-x-1/2 pt-1.5 ${visible ? "block" : "hidden"}`}
      >
        <span className="block rounded-sm border border-structure-on-canvas bg-canvas px-2.5 py-1.5 font-body text-[12px] leading-snug text-foreground shadow-md">
          {KEY_TOOLTIP_TEXT}
        </span>
      </span>
    </span>
  );
}

export type LlmProviderInfo = {
  provider: "ollama" | "cloud";
  local: boolean;
  model?: string;
  models?: OllamaModel[];
  cloud?: CloudInfo;
  /** The "Search" line: which embeddings search uses, and the built-in model's download state (lib/embeddings/searchStatus.ts). */
  search?: SearchStatus;
};

/** Base URL and, when it should change, key source for a switch to `next`: the saved
 * settings when `next` is the saved provider, else its preset defaults. A previous
 * preset's untouched default secret file is never carried over to another provider. */
export function draftOnProviderSwitch(
  next: CloudProviderId,
  saved: CloudInfo | undefined,
  current: { providerId: CloudProviderId; keySourceType: KeySourceType; filePath: string },
): { baseUrl: string; keySource?: PublicKeySource } {
  if (saved?.providerId === next) return { baseUrl: saved.baseUrl ?? "", keySource: saved.keySource };
  const nextPreset = CLOUD_PROVIDERS.find((p) => p.id === next);
  const baseUrl = nextPreset?.editableBaseUrl ? (nextPreset.baseUrl ?? "") : "";
  if (nextPreset?.defaultKeySource) return { baseUrl, keySource: nextPreset.defaultKeySource };
  const prevDefault = CLOUD_PROVIDERS.find((p) => p.id === current.providerId)?.defaultKeySource;
  const onPrevDefault = current.keySourceType === "file" && current.filePath === prevDefault?.path;
  return onPrevDefault ? { baseUrl, keySource: { type: "inline" } } : { baseUrl };
}

// Settings' "Model" section: Local (Ollama) / Cloud switch, cloud being any
// provider in lib/llm/providers.ts. `initialInfo` is a test seam (no
// network); otherwise fetches GET /api/llm on mount. Selecting "Cloud" only
// reveals the panel — the switch is committed by Save, and only with a
// resolvable, format-valid key (POST /api/llm/config, loopback-only).
export default function ModelSection({ initialInfo }: { initialInfo?: LlmProviderInfo }) {
  const uid = useId();
  const modelId = `${uid}-model`;
  const providerSelectId = `${uid}-provider`;
  const baseUrlId = `${uid}-base-url`;
  const keySourceId = `${uid}-key-source`;
  const keyValueId = `${uid}-key-value`;
  const keyTooltipId = `${uid}-key-tooltip`;
  const cloudModelId = `${uid}-cloud-model`;

  const [info, setInfo] = useState<LlmProviderInfo | null>(initialInfo ?? null);
  const [uiProvider, setUiProvider] = useState<"ollama" | "cloud">(initialInfo?.provider ?? "ollama");
  const [localModel, setLocalModelState] = useState<string | null>(() => getModel());

  const cloud = initialInfo?.cloud;
  const [providerId, setProviderId] = useState<CloudProviderId>(cloud?.providerId ?? "anthropic");
  const [baseUrl, setBaseUrl] = useState(cloud?.baseUrl ?? "");
  const [cloudModel, setCloudModel] = useState(cloud?.model ?? "");
  const [keySourceType, setKeySourceType] = useState<KeySourceType>(cloud?.keySource.type ?? "inline");
  const [keyDraft, setKeyDraft] = useState(""); // never prefilled from a saved secret
  const [envName, setEnvName] = useState(cloud?.keySource.type === "env" ? cloud.keySource.name : "");
  const [filePath, setFilePath] = useState(cloud?.keySource.type === "file" ? cloud.keySource.path : "");
  const [cloudModelsList, setCloudModelsList] = useState<string[]>([]);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [loadingModels, setLoadingModels] = useState(false);

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; error?: string } | null>(null);

  function resetCloudDraft(i: LlmProviderInfo | null) {
    const c = i?.cloud;
    setProviderId(c?.providerId ?? "anthropic");
    setBaseUrl(c?.baseUrl ?? "");
    setCloudModel(c?.model ?? "");
    setKeySourceType(c?.keySource.type ?? "inline");
    setKeyDraft("");
    setEnvName(c?.keySource.type === "env" ? c.keySource.name : "");
    setFilePath(c?.keySource.type === "file" ? c.keySource.path : "");
    setCloudModelsList([]);
    setModelsError(null);
  }

  async function refresh() {
    try {
      const res = await fetch("/api/llm");
      if (res.ok) {
        const json = await res.json();
        setInfo(json);
        setUiProvider(json.provider);
        resetCloudDraft(json);
      }
    } catch {
      /* offline / unreachable — keep the last known info showing */
    }
  }

  useEffect(() => {
    if (!initialInfo) refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A blank pasted-key field reuses the already-saved key for this provider
  // (server-side, only for the same provider and base URL) rather than sending an
  // empty inline key — lets Save/Test key/Load models work on a saved key the
  // draft never re-shows.
  function currentKeySource(): (PublicKeySource & { key?: string }) | { type: "saved" } {
    if (keySourceType === "env") return { type: "env", name: envName.trim() };
    if (keySourceType === "file") return { type: "file", path: filePath.trim() };
    if (!keyDraft.trim()) return { type: "saved" };
    return { type: "inline", key: keyDraft.trim() } as any;
  }

  async function selectLocal() {
    if (uiProvider === "ollama" && info?.provider === "ollama") return;
    setError(null);
    setTestResult(null);
    setSaving(true);
    try {
      const res = await fetch("/api/llm/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "ollama" }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(json?.error ?? `HTTP ${res.status}`);
        return;
      }
      await refresh();
    } catch {
      setError("Couldn't reach the server. Try again.");
    } finally {
      setSaving(false);
    }
  }

  function selectCloud() {
    // Reveal only — the provider switch commits on Save, and only with a working key.
    setUiProvider("cloud");
  }

  async function handleSaveCloud() {
    setSaving(true);
    setError(null);
    setTestResult(null);
    try {
      const body = {
        provider: "cloud",
        cloud: {
          providerId,
          ...(preset?.editableBaseUrl ? { baseUrl: baseUrl.trim() } : {}),
          ...(cloudModel.trim() ? { model: cloudModel.trim() } : {}),
          keySource: currentKeySource(),
        },
      };
      const res = await fetch("/api/llm/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(json?.error ?? "Please enter a key for your cloud provider.");
        return;
      }
      await refresh();
    } catch {
      setError("Couldn't reach the server. Try again.");
    } finally {
      setSaving(false);
    }
  }

  async function handleRemoveCloud() {
    setSaving(true);
    setError(null);
    setTestResult(null);
    try {
      const res = await fetch("/api/llm/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "ollama", clearCloud: true }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(json?.error ?? `HTTP ${res.status}`);
        return;
      }
      setUiProvider("ollama");
      await refresh();
    } catch {
      setError("Couldn't reach the server. Try again.");
    } finally {
      setSaving(false);
    }
  }

  async function handleTestKey() {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await fetch("/api/llm/test-key", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          providerId,
          ...(preset?.editableBaseUrl ? { baseUrl: baseUrl.trim() } : {}),
          ...(cloudModel.trim() ? { model: cloudModel.trim() } : {}),
          keySource: currentKeySource(),
        }),
      });
      const json = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
      setTestResult(json);
    } catch {
      setTestResult({ ok: false, error: "Couldn't reach the server." });
    } finally {
      setTesting(false);
    }
  }

  async function handleLoadModels() {
    setLoadingModels(true);
    setModelsError(null);
    try {
      const res = await fetch("/api/llm/models", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          providerId,
          ...(preset?.editableBaseUrl ? { baseUrl: baseUrl.trim() } : {}),
          keySource: currentKeySource(),
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || json?.error) {
        setModelsError(json?.error ?? `HTTP ${res.status}`);
        return;
      }
      setCloudModelsList(json.models ?? []);
    } catch {
      setModelsError("Couldn't reach the server.");
    } finally {
      setLoadingModels(false);
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

  const localModels = info?.models ?? null;
  const preset = CLOUD_PROVIDERS.find((p) => p.id === providerId);
  // The persisted provider (what actually runs searches), independent of
  // which panel is open for editing — a revealed-but-unsaved Cloud panel, or
  // a failed Save, must not make this look switched.
  const activeProvider = info?.provider ?? "ollama";
  const activeCloudLabel = CLOUD_PROVIDERS.find((p) => p.id === info?.cloud?.providerId)?.label;
  const modelRequired = uiProvider === "cloud" && providerId !== "anthropic" && !preset?.defaultModel;
  const canReuseSavedKey =
    Boolean(info?.cloud?.hasKey) && info?.cloud?.keySource.type === "inline" && isSameCloudTarget(info.cloud, providerId, baseUrl);

  function keySourceStatusLine(): string | null {
    if (!info?.cloud?.hasKey) return null;
    const ks = info.cloud.keySource;
    if (ks.type === "env") return `Using key from environment variable ${ks.name}`;
    if (ks.type === "file") return `Using key from ${ks.path}`;
    return `Key saved ••••${info.cloud.keyHint ?? ""}`;
  }

  return (
    <div className={fieldWrapClass} data-testid="model-section">
      <span className={legendClass}>Model</span>
      <div className="mt-2 flex gap-2" role="group" aria-label="LLM provider">
        <button
          type="button"
          className={segBtnClass(activeProvider === "ollama")}
          aria-pressed={activeProvider === "ollama"}
          disabled={saving}
          onClick={selectLocal}
        >
          Local (Ollama)
        </button>
        <button
          type="button"
          className={segBtnClass(activeProvider === "cloud")}
          aria-pressed={activeProvider === "cloud"}
          disabled={saving}
          onClick={selectCloud}
        >
          Cloud
        </button>
      </div>
      <p className="mt-1.5 font-body text-[12px] text-foreground opacity-70" data-testid="active-provider">
        Active: {activeProvider === "cloud" ? `Cloud${activeCloudLabel ? ` (${activeCloudLabel})` : ""}` : "Local"}
      </p>

      {uiProvider === "ollama" && (
        <div data-testid="model-panel-local" className="mt-3">
          {localModels && localModels.length > 0 ? (
            <>
              <label className={legendClass} htmlFor={modelId}>
                Local model
              </label>
              <select
                id={modelId}
                value={localModel ?? ""}
                onChange={(e) => {
                  const v = e.target.value || null;
                  setLocalModelState(v);
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

      {uiProvider === "cloud" && (
        <div data-testid="model-panel-cloud" className="mt-3">
          {keySourceStatusLine() && (
            <p className={`${labelTextClass} mb-2`} data-testid="cloud-key-status">
              {keySourceStatusLine()}
            </p>
          )}

          <label className={legendClass} htmlFor={providerSelectId}>
            Cloud provider
          </label>
          <select
            id={providerSelectId}
            value={providerId}
            onChange={(e) => {
              const next = e.target.value as CloudProviderId;
              setProviderId(next);
              // A model picked for one provider is never valid for another — the
              // "gpt-4o-mini" carried onto an Anthropic save was exactly this bug.
              setCloudModel("");
              setCloudModelsList([]);
              setModelsError(null);
              const draft = draftOnProviderSwitch(next, info?.cloud, { providerId, keySourceType, filePath });
              setBaseUrl(draft.baseUrl);
              if (draft.keySource) {
                const ks = draft.keySource;
                setKeySourceType(ks.type);
                setEnvName(ks.type === "env" ? ks.name : "");
                setFilePath(ks.type === "file" ? ks.path : "");
              }
            }}
            className={inputClass}
          >
            {CLOUD_PROVIDERS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>

          {preset?.editableBaseUrl && (
            <div className="mt-3">
              <label className={legendClass} htmlFor={baseUrlId}>
                Base URL
              </label>
              <input
                id={baseUrlId}
                type="text"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder={preset.baseUrl ?? "https://your-endpoint.example.com/v1"}
                className={inputClass}
              />
            </div>
          )}

          {preset?.privacyNote && (
            <p className="mt-3 rounded-r-sm border-l-2 border-structure-on-canvas bg-canvas-alt px-3 py-2 font-body text-[12px] text-foreground" data-testid="cloud-privacy-note">
              {preset.privacyNote}
            </p>
          )}

          <div className="mt-3">
            <label className={legendClass} htmlFor={keySourceId}>
              Key source
            </label>
            <KeyInfoTooltip id={keyTooltipId} />
            <select
              id={keySourceId}
              value={keySourceType}
              onChange={(e) => setKeySourceType(e.target.value as KeySourceType)}
              className={inputClass}
            >
              <option value="inline">Paste key</option>
              <option value="env">Environment variable</option>
              <option value="file">Secret file</option>
            </select>

            {keySourceType === "inline" && (
              <input
                id={keyValueId}
                type="password"
                value={keyDraft}
                onChange={(e) => setKeyDraft(e.target.value)}
                placeholder={
                  canReuseSavedKey
                    ? "Leave blank to keep the saved key"
                    : preset?.id === "anthropic"
                      ? "sk-ant-..."
                      : "API key"
                }
                className={`${inputClass} mt-2`}
                autoComplete="off"
                aria-describedby={keyTooltipId}
              />
            )}
            {keySourceType === "env" && (
              <input
                id={keyValueId}
                type="text"
                value={envName}
                onChange={(e) => setEnvName(e.target.value)}
                placeholder="MY_PROVIDER_API_KEY"
                className={`${inputClass} mt-2`}
                autoComplete="off"
                aria-describedby={keyTooltipId}
              />
            )}
            {keySourceType === "file" && (
              <input
                id={keyValueId}
                type="text"
                value={filePath}
                onChange={(e) => setFilePath(e.target.value)}
                placeholder="/absolute/path/to/key.txt"
                className={`${inputClass} mt-2`}
                autoComplete="off"
                aria-describedby={keyTooltipId}
              />
            )}
          </div>

          <div className="mt-3">
            <label className={legendClass} htmlFor={cloudModelId}>
              Model{modelRequired ? " (required)" : ""}
            </label>
            <input
              id={cloudModelId}
              type="text"
              value={cloudModel}
              onChange={(e) => setCloudModel(e.target.value)}
              placeholder={preset?.defaultModel ?? (modelRequired ? "Required — this provider has no default" : "Default")}
              required={modelRequired}
              className={inputClass}
              list={`${cloudModelId}-list`}
            />
            {cloudModelsList.length > 0 && (
              <datalist id={`${cloudModelId}-list`}>
                {cloudModelsList.map((m) => (
                  <option key={m} value={m} />
                ))}
              </datalist>
            )}
            <div className="mt-2 flex items-center gap-2">
              <button type="button" className={smallBtnClass} onClick={handleLoadModels} disabled={loadingModels}>
                {loadingModels ? "Loading models…" : "Load models"}
              </button>
              {modelsError && <span className="font-body text-[12px] text-foreground">{modelsError}</span>}
            </div>
          </div>

          <div className="mt-3 flex flex-wrap gap-2">
            <button type="button" className={smallBtnClass} onClick={handleSaveCloud} disabled={saving}>
              {saving ? "Saving…" : "Save"}
            </button>
            <button type="button" className={smallBtnClass} onClick={handleTestKey} disabled={testing}>
              {testing ? "Testing…" : "Test key"}
            </button>
            {info?.cloud?.fromEnv ? (
              <span className="font-body text-[12px] text-foreground" data-testid="cloud-from-env">
                From {info.cloud.keySource.type === "env" ? info.cloud.keySource.name : "an environment variable"} in
                .env.local — edit that file to change or remove it.
              </span>
            ) : (
              <button type="button" className={smallBtnClass} onClick={handleRemoveCloud} disabled={saving || !info?.cloud}>
                Remove
              </button>
            )}
            {testResult && (
              <span className="font-body text-[12px] text-foreground">
                {testResult.ok ? "Key works." : testResult.error ?? "Test failed."}
              </span>
            )}
          </div>
        </div>
      )}

      {/* Search runs on its own embeddings, whichever model does the scoring: say which, and the built-in model's download state. */}
      <LocalSearchStatus initialStatus={info?.search} />

      {error && (
        <p className="mt-2 rounded-r-sm border-l-2 border-error bg-canvas-alt px-3 py-2 font-body text-[12px] text-foreground">
          {error}
        </p>
      )}
    </div>
  );
}
