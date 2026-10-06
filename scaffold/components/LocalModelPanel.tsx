"use client";

import React, { useEffect, useId, useRef, useState } from "react";
import {
  classifyOllamaStatus,
  effectiveLocalModel,
  pickNotInstalled,
  sameModel,
  type OllamaJob,
  type OllamaState,
  type OllamaStatus,
} from "@/lib/llm/ollamaModels";
import ReportProblemLink from "@/components/ReportProblemLink";
import { reportClientError } from "@/lib/errorLog/client";
import { isErrorId } from "@/lib/errorLog/errorId";

/** Ollama has chat models, but not the configured default (Default then runs another installed one). */
export function configuredMissing(s: OllamaStatus): boolean {
  return s.isOllama && s.chatModels.length > 0 && !s.chatModels.some((m) => sameModel(m.name, s.configuredModel));
}

/** Pure: the Local panel's headline for a status, with the model searches would use. */
export function describeLocalSetup(
  s: OllamaStatus,
  selectedModel: string | null,
): { state: OllamaState; model: string; title: string; detail?: string; notice?: string } {
  const installed = s.chatModels.map((m) => m.name);
  // s.defaultModel is already an installed model whenever any chat model is installed.
  const model = effectiveLocalModel(selectedModel, installed, s.defaultModel);
  const state = classifyOllamaStatus({ ...s, model });
  const pickGone = Boolean(selectedModel) && installed.length > 0 && !installed.some((n) => sameModel(n, selectedModel));
  const notice = pickGone ? pickNotInstalled(selectedModel!, model) : undefined;
  const view = describeState(s, state, model);
  return notice ? { ...view, notice } : view;
}

function describeState(s: OllamaStatus, state: OllamaState, model: string): { state: OllamaState; model: string; title: string; detail?: string } {
  switch (state) {
    case "not_installed":
      return {
        state,
        model,
        title: "Ollama isn't installed.",
        detail: "Local runs an AI model on this computer with Ollama, a free app, so nothing leaves your computer. Install it to search on Local.",
      };
    case "not_running":
      return s.canManage
        ? { state, model, title: "Ollama is installed but isn't running.", detail: "Searches on Local need it running." }
        : {
            state,
            model,
            title: `Couldn't reach the local model server at ${s.host}.`,
            detail: "Granted only installs and starts Ollama on this computer (port 11434). Start this server yourself, then check again.",
          };
    case "no_chat_models": {
      const embedNote = s.embeddingModels.length
        ? ` (${s.embeddingModels.join(", ")} ${s.embeddingModels.length === 1 ? "is an embedding model" : "are embedding models"} and can't run searches.)`
        : "";
      return { state, model, title: "Ollama is running, but no chat model is installed.", detail: `Download one to search on Local.${embedNote}` };
    }
    case "external":
      return { state, model, title: `Using the OpenAI-compatible server at ${s.host}.`, detail: `Model: ${model}.` };
    default: {
      const title = "Runs on your own machine via Ollama — nothing leaves your computer.";
      return configuredMissing(s)
        ? {
            state,
            model,
            title,
            detail: `The configured default, ${s.configuredModel}, isn't installed, so Default uses ${s.defaultModel}. Pick another model below, or download ${s.configuredModel}.`,
          }
        : { state, model, title };
    }
  }
}

const legendClass = "font-mono text-[11px] uppercase tracking-eyebrow text-foreground";
const inputClass =
  "mt-1.5 w-full rounded-sm border border-structure-on-canvas bg-canvas px-2.5 py-1.5 font-body text-[13px] text-foreground outline-none transition focus:border-structure-on-canvas focus:ring-2 focus:ring-structure-on-canvas";
const smallBtnClass =
  "inline-flex min-h-[36px] items-center rounded-sm border border-structure-on-canvas px-3 py-1.5 font-mono text-[11px] uppercase tracking-eyebrow text-structure-on-canvas transition hover:bg-structure hover:text-token-white disabled:opacity-50";
const noteClass = "mt-1.5 font-body text-[12px] text-foreground opacity-80";

function JobLine({ job, testId, onCancel }: { job?: OllamaJob; testId: string; onCancel?: () => void }) {
  if (!job || job.status === "done") return null;
  if (job.status === "error") {
    return (
      <p className="mt-2 rounded-r-sm border-l-2 border-error bg-canvas-alt px-3 py-2 font-body text-[12px] text-foreground" data-testid={testId}>
        {job.error}
        {/* A failed download / install / start is a problem worth reporting; a cancel isn't (no id). */}
        {job.errorId && (
          <span className="mt-1 block">
            <ReportProblemLink errorId={job.errorId} area="ollama" message={job.error} />
          </span>
        )}
      </p>
    );
  }
  return (
    <div className="mt-2" data-testid={testId}>
      <div className="flex flex-wrap items-center gap-2">
        <p className="font-body text-[12px] text-foreground">{job.message ?? "Working…"}</p>
        {onCancel && (
          <button type="button" className={smallBtnClass} onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
      {typeof job.pct === "number" && (
        <div className="mt-1 h-1.5 w-full rounded-sm bg-canvas-alt" role="progressbar" aria-valuenow={job.pct} aria-valuemin={0} aria-valuemax={100}>
          <div className="h-1.5 rounded-sm bg-structure" style={{ width: `${job.pct}%` }} />
        </div>
      )}
    </div>
  );
}

/**
 * Settings → Model → Local. Says what's wrong with the local setup and offers
 * the fix: install Ollama (one click on Windows), start it, download a model,
 * pick an installed one. `initialStatus` comes from GET /api/llm; this polls
 * GET /api/llm/ollama while a job runs, and starts Ollama by itself once when
 * it's installed but stopped.
 */
export default function LocalModelPanel({
  initialStatus,
  selectedModel,
  onSelectModel,
  pollMs = 1500,
}: {
  initialStatus?: OllamaStatus;
  selectedModel: string | null;
  onSelectModel: (model: string | null) => void;
  pollMs?: number;
}) {
  const modelId = `${useId()}-local-model`;
  const [status, setStatus] = useState<OllamaStatus | undefined>(initialStatus);
  const [checking, setChecking] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  // Only for real failures (the server's, or the server unreachable): "start Ollama first" and
  // the like are guidance, with nothing to report.
  const [actionErrorId, setActionErrorId] = useState<string | null>(null);
  const autoStarted = useRef(false);
  const pullTarget = useRef<string | null>(null);

  useEffect(() => {
    if (initialStatus) setStatus(initialStatus);
  }, [initialStatus]);

  async function refresh() {
    setChecking(true);
    try {
      const res = await fetch("/api/llm/ollama");
      if (res.ok) setStatus(await res.json());
    } catch {
      /* server restarting: keep the last status */
    } finally {
      setChecking(false);
    }
  }

  // Before the first status arrives (no initialStatus), fetch it.
  useEffect(() => {
    if (!initialStatus) void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const jobs = status?.jobs ?? {};
  const running = [jobs.start, jobs.pull, jobs.install].some((j) => j?.status === "running");
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => void refresh(), pollMs);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running, pollMs]);

  async function act(action: "start" | "pull" | "install" | "cancel", model?: string, job?: "pull" | "install") {
    setActionError(null);
    setActionErrorId(null);
    if (action === "pull") pullTarget.current = model ?? null;
    try {
      const res = await fetch("/api/llm/ollama", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, ...(model ? { model } : {}), ...(job ? { job } : {}) }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setActionError(json?.error ?? `HTTP ${res.status}`);
        if (res.status >= 500) setActionErrorId(isErrorId(json?.errorId) ? json.errorId : reportClientError("ollama", `HTTP ${res.status}`));
      }
    } catch (err) {
      setActionError("Couldn't reach the server. Try again.");
      setActionErrorId(reportClientError("ollama", err));
    }
    await refresh();
  }

  const view = status ? describeLocalSetup(status, selectedModel) : null;

  // Installed but stopped: start it once, without a click.
  useEffect(() => {
    if (view?.state !== "not_running" || !status?.canManage || autoStarted.current || jobs.start) return;
    autoStarted.current = true;
    void act("start");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view?.state, status?.canManage]);

  // A download that finishes while searches have no usable model: use it.
  useEffect(() => {
    const pulled = jobs.pull?.status === "done" ? jobs.pull.model : undefined;
    if (!pulled || pullTarget.current !== pulled || !status) return;
    pullTarget.current = null;
    if (view && view.state !== "ok" && !sameModel(pulled, status.defaultModel)) onSelectModel(pulled);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobs.pull?.status, jobs.pull?.model]);

  if (!status || !view) {
    return (
      <div data-testid="local-setup" data-state="checking">
        <p className="font-body text-[12px] text-foreground opacity-80">
          Runs on your own machine via Ollama — nothing leaves your computer. Checking Ollama…
        </p>
      </div>
    );
  }

  const installedNames = status.chatModels.map((m) => m.name);
  const pulling = jobs.pull?.status === "running";
  const showConfiguredDownload = view.state === "ok" && configuredMissing(status);
  const downloadChoices = [
    ...(showConfiguredDownload ? [status.configuredModel] : []),
    ...(view.state === "ok" ? [] : status.suggestions),
  ].filter((m, i, all) => all.findIndex((x) => sameModel(x, m)) === i && !installedNames.some((n) => sameModel(n, m)));
  const showDownloads = status.running && status.isOllama;
  const showPicker = status.isOllama && status.chatModels.length > 0;
  const defaultInstalled = installedNames.some((n) => sameModel(n, status.defaultModel));

  return (
    <div data-testid="local-setup" data-state={view.state}>
      <p className={`font-body text-[13px] text-foreground ${view.state === "ok" ? "opacity-80" : ""}`} data-testid="local-setup-title">
        {view.title}
      </p>
      {view.detail && <p className={noteClass}>{view.detail}</p>}
      {view.notice && (
        <p className="mt-1.5 rounded-r-sm border-l-2 border-structure-on-canvas bg-canvas-alt px-3 py-2 font-body text-[12px] text-foreground" data-testid="local-pick-notice">
          {view.notice}
        </p>
      )}

      {view.state === "not_installed" && (
        <div className="mt-2" data-testid="local-install">
          {status.install.auto ? (
            <>
              <button type="button" className={smallBtnClass} onClick={() => act("install")} disabled={jobs.install?.status === "running"}>
                {jobs.install?.status === "running" ? "Installing Ollama…" : "Install Ollama"}
              </button>
              <p className={noteClass}>
                Installs with <code>{status.install.command}</code>
                {status.install.auto === "winget" ? ", or the official installer if that fails" : " (official installer)"}. Or{" "}
                <a className="underline" href={status.install.url} target="_blank" rel="noreferrer">
                  download it from ollama.com
                </a>
                .
              </p>
            </>
          ) : (
            <p className={noteClass}>
              <a className="underline" href={status.install.url} target="_blank" rel="noreferrer">
                Download Ollama from ollama.com
              </a>{" "}
              or run <code>{status.install.command}</code>, start it, then check again.
            </p>
          )}
          <JobLine job={jobs.install} testId="local-install-progress" onCancel={() => act("cancel", undefined, "install")} />
        </div>
      )}

      {view.state === "not_running" && status.canManage && (
        <div className="mt-2" data-testid="local-start">
          <button type="button" className={smallBtnClass} onClick={() => act("start")} disabled={jobs.start?.status === "running"}>
            {jobs.start?.status === "running" ? "Starting Ollama…" : "Start Ollama"}
          </button>
          <JobLine job={jobs.start} testId="local-start-progress" />
        </div>
      )}

      {showPicker && (
        <div className="mt-3">
          <label className={legendClass} htmlFor={modelId}>
            Local model
          </label>
          <select
            id={modelId}
            value={selectedModel && installedNames.some((n) => sameModel(n, selectedModel)) ? selectedModel : ""}
            onChange={(e) => onSelectModel(e.target.value || null)}
            className={inputClass}
          >
            <option value="">
              Default ({status.defaultModel}){defaultInstalled ? "" : " — not installed"}
            </option>
            {status.chatModels.map((m) => (
              <option key={m.name} value={m.name}>
                {m.name}
                {m.paramsB != null ? ` (${m.paramsB}B)` : ""}
              </option>
            ))}
          </select>
          <p className={noteClass}>Which installed Ollama model runs your search. Larger models are more capable but slower.</p>
        </div>
      )}

      {showDownloads && (view.state !== "ok" || showConfiguredDownload) && (
        <div className="mt-3" data-testid="local-download">
          <span className={legendClass}>Download a model</span>
          {view.state !== "ok" && (
            <p className={noteClass}>
              Recommended for this computer{status.recommended.memGB ? ` (${status.recommended.memGB} GB of memory)` : ""}:{" "}
              <strong>{status.recommended.model}</strong>. {status.recommended.note}
            </p>
          )}
          <div className="mt-2 flex flex-wrap gap-2">
            {downloadChoices.map((m) => (
              <button key={m} type="button" className={smallBtnClass} onClick={() => act("pull", m)} disabled={pulling}>
                Download {m}
                {sameModel(m, status.recommended.model) ? " (recommended)" : ""}
              </button>
            ))}
          </div>
          <JobLine job={jobs.pull} testId="local-pull-progress" onCancel={() => act("cancel", undefined, "pull")} />
        </div>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button type="button" className={smallBtnClass} onClick={() => void refresh()} disabled={checking}>
          {checking ? "Checking…" : "Check again"}
        </button>
        {actionError && <span className="font-body text-[12px] text-foreground">{actionError}</span>}
        {actionError && actionErrorId && <ReportProblemLink errorId={actionErrorId} area="ollama" message={actionError} />}
      </div>
    </div>
  );
}
