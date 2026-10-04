import { useCallback, useEffect, useState } from "react";
import type { GrantedSetupState, TaskStatusEvent } from "../../../shared/ipc";

/**
 * Shown once the install finishes. Offers to do the README's "Next steps"
 * for the user — configure .env.local (their API keys, or the fully-local
 * Ollama setup), start `npm run dev`, and open the browser — instead of
 * leaving them to type those commands into the console.
 */
type Step =
  | { id: "loading" }
  | { id: "ask" }
  | { id: "choose" }
  | { id: "keys" }
  | { id: "local-setup" }
  | { id: "starting" }
  | { id: "opened"; message: string | null; url: string }
  | { id: "declined" }
  | { id: "error"; message: string; retry: () => void };

export default function InstallComplete(): React.JSX.Element {
  const [setup, setSetup] = useState<GrantedSetupState | null>(null);
  const [step, setStep] = useState<Step>({ id: "loading" });

  useEffect(() => {
    window.api
      .getSetupState()
      .then((state) => {
        setSetup(state);
        setStep({ id: "ask" });
      })
      .catch(() => setStep({ id: "ask" }));
  }, []);

  const start = useCallback((): void => {
    setStep({ id: "starting" });
    window.api.startGranted().then((result) => {
      if (!result.ok) setStep({ id: "error", message: result.message, retry: start });
    });
  }, []);

  const runLocalSetup = useCallback((): void => {
    setStep({ id: "local-setup" });
    window.api.runLocalSetup().then((result) => {
      if (!result.ok) setStep({ id: "error", message: result.message, retry: runLocalSetup });
    });
  }, []);

  useEffect(() => {
    return window.api.onTaskStatus((status: TaskStatusEvent) => {
      if (status.task === "local-setup") {
        if (status.state === "done") start();
        else setStep({ id: "error", message: status.message ?? "The local setup didn't finish.", retry: runLocalSetup });
      } else if (status.state === "done") {
        setStep({ id: "opened", message: status.message ?? null, url: status.url ?? "http://localhost:3000" });
      } else {
        setStep({ id: "error", message: status.message ?? "Granted didn't start.", retry: start });
      }
    });
  }, [start, runLocalSetup]);

  const handleYes = (): void => {
    // Already configured on an earlier run — nothing to ask, just start it.
    if (setup?.hostedKeysSet || setup?.localConfigured) start();
    else setStep({ id: "choose" });
  };

  const installDir = setup?.installDir ?? "your granted folder";

  return (
    <main className="screen">
      <h1>Installation complete</h1>
      <p className="subtitle">Granted is installed in {installDir}.</p>

      {step.id === "loading" && <p>Just a moment…</p>}

      {step.id === "ask" && (
        <>
          <p className="question">Open Granted now?</p>
          <div className="actions">
            <button type="button" className="primary" onClick={handleYes}>
              Yes, open Granted
            </button>
            <button type="button" className="secondary" onClick={() => setStep({ id: "declined" })}>
              Not now
            </button>
          </div>
        </>
      )}

      {step.id === "choose" && (
        <>
          <p className="question">How should Granted run?</p>
          <div className="choices">
            <button type="button" className="choice" onClick={() => setStep({ id: "keys" })}>
              <strong>Use my API keys</strong>
              <span>Fastest. Uses OpenAI and Anthropic — you'll need a key from each.</span>
            </button>
            <button type="button" className="choice" onClick={runLocalSetup}>
              <strong>Run everything on this computer</strong>
              <span>
                No API keys, works offline. Downloads an AI model (several GB) and can take up to half an hour the first
                time.
              </span>
            </button>
          </div>
          <button type="button" className="link" onClick={() => setStep({ id: "ask" })}>
            Back
          </button>
        </>
      )}

      {step.id === "keys" && <ApiKeysForm onSaved={start} onBack={() => setStep({ id: "choose" })} />}

      {step.id === "local-setup" && (
        <div className="status-note">
          Setting up the local AI model in a separate PowerShell window. This can take up to half an hour — Granted will
          open in your browser by itself when it's done.
        </div>
      )}

      {step.id === "starting" && (
        <div className="status-note">
          Starting Granted… A PowerShell window titled <strong>Granted</strong> opened — keep it open while you use
          Granted. Your browser will open when it's ready (the first start can take a minute or two).
        </div>
      )}

      {step.id === "opened" && (
        <>
          <div className="status-note">
            {step.message ?? "Granted is open in your browser."} It's at <code>{step.url}</code>. Keep the{" "}
            <strong>Granted</strong> PowerShell window open while you use it — closing that window stops Granted.
          </div>
          <div className="actions spaced">
            <button type="button" className="primary" onClick={() => window.api.quit()}>
              Close installer
            </button>
          </div>
        </>
      )}

      {step.id === "declined" && (
        <>
          <p>To open Granted later, run these in PowerShell:</p>
          <code className="command">{`cd "${installDir}\\scaffold"
npm run setup                  # your API keys (OpenAI + Anthropic), or
npm run setup:local -- --yes   # fully local via Ollama, no API keys
npm run dev                    # then open http://localhost:3000`}</code>
          <div className="actions spaced">
            <button type="button" className="primary" onClick={() => window.api.quit()}>
              Close installer
            </button>
            <button type="button" className="secondary" onClick={() => setStep({ id: "ask" })}>
              Back
            </button>
          </div>
        </>
      )}

      {step.id === "error" && (
        <>
          <div className="status-note error">{step.message}</div>
          <div className="actions spaced">
            <button type="button" className="primary" onClick={step.retry}>
              Try again
            </button>
            <button type="button" className="secondary" onClick={() => setStep({ id: "ask" })}>
              Back
            </button>
          </div>
        </>
      )}
    </main>
  );
}

function ApiKeysForm({ onSaved, onBack }: { onSaved: () => void; onBack: () => void }): React.JSX.Element {
  const [openaiApiKey, setOpenai] = useState("");
  const [anthropicApiKey, setAnthropic] = useState("");
  const [exaApiKey, setExa] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = (e: React.FormEvent): void => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    window.api
      .saveApiKeys({ openaiApiKey, anthropicApiKey, exaApiKey })
      .then((result) => {
        if (result.ok) onSaved();
        else setError(result.message);
      })
      .finally(() => setSaving(false));
  };

  return (
    <form className="keys-form" onSubmit={handleSubmit}>
      <p className="question">Your API keys</p>
      <p className="detail">Saved only on this computer, in Granted's .env.local file.</p>
      <label>
        OpenAI API key <span className="detail">(platform.openai.com/api-keys)</span>
        <input type="password" autoComplete="off" value={openaiApiKey} onChange={(e) => setOpenai(e.target.value)} />
      </label>
      <label>
        Anthropic API key <span className="detail">(console.anthropic.com/settings/keys)</span>
        <input
          type="password"
          autoComplete="off"
          value={anthropicApiKey}
          onChange={(e) => setAnthropic(e.target.value)}
        />
      </label>
      <label>
        Exa API key <span className="detail">(optional — live competitor web results)</span>
        <input type="password" autoComplete="off" value={exaApiKey} onChange={(e) => setExa(e.target.value)} />
      </label>
      {error && <div className="status-note error">{error}</div>}
      <div className="actions spaced">
        <button type="submit" className="primary" disabled={saving}>
          {saving ? "Saving…" : "Save and open Granted"}
        </button>
        <button type="button" className="secondary" onClick={onBack} disabled={saving}>
          Back
        </button>
      </div>
    </form>
  );
}
