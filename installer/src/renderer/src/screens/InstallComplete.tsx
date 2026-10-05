import { useCallback, useEffect, useState } from "react";
import type { GrantedSetupState, OpenIn, ShortcutChoice, TaskStatusEvent } from "../../../shared/ipc";

/**
 * Shown once the install finishes. Offers to do the README's "Next steps"
 * for the user — configure .env.local (their API keys, or the fully-local
 * Ollama setup), start `npm run dev`, and open Granted (in its own window or
 * a browser tab) — instead of
 * leaving them to type those commands into the console.
 */
type Step =
  | { id: "loading" }
  | { id: "ask" }
  | { id: "choose" }
  | { id: "keys" }
  | { id: "local-setup" }
  // background: null until the main process says how it's starting Granted.
  | { id: "starting"; background: boolean | null }
  | { id: "opened"; message: string | null; url: string; background: boolean; openedIn: OpenIn }
  | { id: "declined" }
  | { id: "error"; message: string; retry: () => void };

export default function InstallComplete(): React.JSX.Element {
  const [setup, setSetup] = useState<GrantedSetupState | null>(null);
  const [step, setStep] = useState<Step>({ id: "loading" });
  const [shortcuts, setShortcuts] = useState<ShortcutChoice>({ desktop: true, startMenu: true });
  const [shortcutsNote, setShortcutsNote] = useState<{ ok: boolean; message: string } | null>(null);
  const [shortcutsMade, setShortcutsMade] = useState(false);
  const [applying, setApplying] = useState(false);
  // Ticked = open Granted in its own window (Edge/Chrome app mode), not a browser tab.
  const [ownWindow, setOwnWindow] = useState(true);
  const [openInNote, setOpenInNote] = useState<string | null>(null);

  useEffect(() => {
    window.api
      .getSetupState()
      .then((state) => {
        setSetup(state);
        setOwnWindow(state.openIn !== "browser");
        setStep({ id: "ask" });
      })
      .catch(() => setStep({ id: "ask" }));
  }, []);

  const start = useCallback((): void => {
    setStep({ id: "starting", background: null });
    window.api.startGranted().then((result) => {
      if (!result.ok) setStep({ id: "error", message: result.message, retry: start });
      else setStep((prev) => (prev.id === "starting" ? { ...prev, background: result.background ?? false } : prev));
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
        setStep({
          id: "opened",
          message: status.message ?? null,
          url: status.url ?? "http://localhost:3000",
          background: status.background ?? false,
          openedIn: status.openedIn ?? "browser",
        });
      } else {
        setStep({ id: "error", message: status.message ?? "Granted didn't start.", retry: start });
      }
    });
  }, [start, runLocalSetup]);

  // Creates whichever shortcuts are ticked (once — they're the same files if
  // the user goes Back and continues again). Never blocks continuing: a
  // failure is just noted.
  const applyShortcuts = async (): Promise<void> => {
    if (!setup?.shortcutsAvailable || shortcutsMade || (!shortcuts.desktop && !shortcuts.startMenu)) return;
    const result = await window.api.createShortcuts(shortcuts);
    setShortcutsNote({ ok: result.ok, message: result.message });
    if (result.ok) setShortcutsMade(true);
  };

  // Saved for the tray and shortcuts too, so it applies every time Granted
  // opens. Best effort: if it can't be saved, Granted opens the way it would have.
  const applyOpenIn = async (): Promise<void> => {
    if (!setup?.appWindowAvailable) return;
    const openIn: OpenIn = ownWindow ? "window" : "browser";
    if (openIn === setup.openIn) return;
    const result = await window.api.setOpenIn(openIn).catch(() => ({ ok: false, message: "Couldn't save where Granted opens." }));
    setOpenInNote(result.ok ? null : `${result.message} It will open the way it did before.`);
  };

  const continueWith = (next: () => void): void => {
    setApplying(true);
    void applyOpenIn()
      .then(applyShortcuts)
      .catch(() => setShortcutsNote({ ok: false, message: "Couldn't add the Granted shortcut(s)." }))
      .finally(() => {
        setApplying(false);
        next();
      });
  };

  const handleYes = (): void =>
    continueWith(() => {
      // Already configured on an earlier run — nothing to ask, just start it.
      if (setup?.hostedKeysSet || setup?.localConfigured) start();
      else setStep({ id: "choose" });
    });

  const installDir = setup?.installDir ?? "your granted folder";
  const shortcutPlaces = [
    shortcutsMade && shortcuts.desktop && "on your desktop",
    shortcutsMade && shortcuts.startMenu && "in the Start menu",
  ].filter(Boolean);

  return (
    <main className="screen">
      <h1>Installation complete</h1>
      <p className="subtitle">Granted is installed in {installDir}.</p>

      {step.id === "loading" && <p>Just a moment…</p>}

      {step.id === "ask" && setup && !setup.installed && (
        <>
          <div className="status-note error">
            Couldn't find Granted in {installDir} — the install may not have finished. Check the PowerShell window it ran
            in for errors.
          </div>
          <div className="actions spaced">
            <button type="button" className="primary" onClick={() => window.api.quit()}>
              Close installer
            </button>
          </div>
        </>
      )}

      {step.id === "ask" && (!setup || setup.installed) && (
        <>
          {setup?.shortcutsAvailable && !shortcutsMade && (
            <fieldset className="shortcut-options">
              <legend>Add a Granted shortcut to:</legend>
              <label>
                <input
                  type="checkbox"
                  checked={shortcuts.desktop}
                  onChange={(e) => setShortcuts((s) => ({ ...s, desktop: e.target.checked }))}
                />
                The desktop
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={shortcuts.startMenu}
                  onChange={(e) => setShortcuts((s) => ({ ...s, startMenu: e.target.checked }))}
                />
                The Start menu
              </label>
            </fieldset>
          )}
          {setup?.appWindowAvailable && (
            <label className="open-in-option" title="In its own window, like an app. Untick to open it in a browser tab instead.">
              <input
                type="checkbox"
                checked={ownWindow}
                onChange={(e) => setOwnWindow(e.target.checked)}
                aria-description="In its own window, like an app. Untick to open it in a browser tab instead."
              />
              Open Granted
            </label>
          )}
          <p className="question">Open Granted now?</p>
          <div className="actions">
            <button type="button" className="primary" onClick={handleYes} disabled={applying}>
              Yes, open Granted
            </button>
            <button
              type="button"
              className="secondary"
              onClick={() => continueWith(() => setStep({ id: "declined" }))}
              disabled={applying}
            >
              Not now
            </button>
          </div>
        </>
      )}

      {shortcutsNote && step.id !== "ask" && (
        <div className={`status-note${shortcutsNote.ok ? "" : " error"}`}>{shortcutsNote.message}</div>
      )}
      {openInNote && step.id !== "ask" && <div className="status-note error">{openInNote}</div>}

      {step.id === "choose" && (
        <>
          <p className="question">How should Granted run?</p>
          <div className="choices">
            <button type="button" className="choice" onClick={() => setStep({ id: "keys" })}>
              <strong>Use my API keys</strong>
              <span>Fastest. An OpenAI key is all you need (search uses it); add a Claude key too if you'd like.</span>
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

      {step.id === "keys" && (
        <ApiKeysForm
          openaiKeySet={setup?.openaiKeySet ?? false}
          anthropicKeySet={setup?.anthropicKeySet ?? false}
          onSaved={start}
          onBack={() => setStep({ id: "choose" })}
          onUseLocal={runLocalSetup}
        />
      )}

      {step.id === "local-setup" && (
        <div className="status-note">
          Setting up the local AI model in a separate PowerShell window. This can take up to half an hour — Granted will
          open by itself when it's done. To cancel, close that window.
        </div>
      )}

      {step.id === "starting" &&
        (step.background === null ? (
          <div className="status-note">Starting Granted…</div>
        ) : step.background ? (
          <div className="status-note">
            Starting Granted in the background… It will open when it's ready (the first start can take a minute or
            two).
          </div>
        ) : (
          <div className="status-note">
            Starting Granted… A PowerShell window titled <strong>Granted</strong> opened — keep it open while you use
            Granted. It will open when it's ready (the first start can take a minute or two). To cancel, close
            that window.
          </div>
        ))}

      {step.id === "opened" && (
        <>
          {step.background ? (
            <div className="status-note">
              {step.message ?? openedText(step.openedIn)} It's at <code>{step.url}</code> and keeps running in
              the background — look for the <strong>Granted icon</strong> by the clock (it may be under the ^ arrow).
              Right-click it to open Granted again or to quit it.
              {shortcutPlaces.length > 0 && <> Next time, open it from the Granted shortcut {shortcutPlaces.join(" or ")}.</>}
            </div>
          ) : (
            <div className="status-note">
              {step.message ?? openedText(step.openedIn)} It's at <code>{step.url}</code>. Keep the{" "}
              <strong>Granted</strong> PowerShell window open while you use it — closing that window stops Granted.
            </div>
          )}
          <div className="actions spaced">
            <button type="button" className="primary" onClick={() => window.api.quit()}>
              Close installer
            </button>
          </div>
        </>
      )}

      {step.id === "declined" && (
        <>
          {shortcutPlaces.length > 0 && (
            <p>
              Open Granted any time from the Granted shortcut {shortcutPlaces.join(" or ")}. The first time, set it up
              first (your API keys, or fully local) with:
            </p>
          )}
          {shortcutPlaces.length === 0 && <p>To open Granted later, run these in PowerShell:</p>}
          <code className="command">{`cd "${installDir}\\scaffold"
npm run setup                  # your API key (OpenAI; Claude optional), or
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

// What actually happened — "window" may have been asked for, but with no
// Edge or Chrome on the machine Granted opens in a browser tab instead.
function openedText(openedIn: OpenIn): string {
  return openedIn === "window" ? "Granted is open in its own window." : "Granted is open in your browser.";
}

const KEEP_EXISTING = "Already set — leave blank to keep it";

function ApiKeysForm({
  openaiKeySet,
  anthropicKeySet,
  onSaved,
  onBack,
  onUseLocal,
}: {
  openaiKeySet: boolean;
  anthropicKeySet: boolean;
  onSaved: () => void;
  onBack: () => void;
  onUseLocal: () => void;
}): React.JSX.Element {
  const [openaiApiKey, setOpenai] = useState("");
  const [anthropicApiKey, setAnthropic] = useState("");
  const [exaApiKey, setExa] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<{ message: string; suggestLocal: boolean } | null>(null);

  const handleSubmit = (e: React.FormEvent): void => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    window.api
      .saveApiKeys({ openaiApiKey, anthropicApiKey, exaApiKey })
      .then((result) => {
        if (result.ok) onSaved();
        else setError({ message: result.message, suggestLocal: result.suggestLocal ?? false });
      })
      .finally(() => setSaving(false));
  };

  return (
    <form className="keys-form" onSubmit={handleSubmit}>
      <p className="question">Your API keys</p>
      <p className="detail">
        One key is enough: search works with an OpenAI key, and it can do the scoring too. Add a Claude key if you'd
        like Claude to do the scoring. Saved only on this computer, in Granted's .env.local file.
      </p>
      <label>
        OpenAI API key <span className="detail">(needed for search — platform.openai.com/api-keys)</span>
        <input
          type="password"
          autoComplete="off"
          placeholder={openaiKeySet ? KEEP_EXISTING : undefined}
          value={openaiApiKey}
          onChange={(e) => setOpenai(e.target.value)}
        />
      </label>
      <label>
        Anthropic (Claude) API key{" "}
        <span className="detail">(optional — Claude does the scoring if you add it; console.anthropic.com/settings/keys)</span>
        <input
          type="password"
          autoComplete="off"
          placeholder={anthropicKeySet ? KEEP_EXISTING : undefined}
          value={anthropicApiKey}
          onChange={(e) => setAnthropic(e.target.value)}
        />
      </label>
      <label>
        Exa API key <span className="detail">(optional — live competitor web results)</span>
        <input type="password" autoComplete="off" value={exaApiKey} onChange={(e) => setExa(e.target.value)} />
      </label>
      {error && <div className="status-note error">{error.message}</div>}
      <div className="actions spaced">
        <button type="submit" className="primary" disabled={saving}>
          {saving ? "Saving…" : "Save and open Granted"}
        </button>
        {error?.suggestLocal && (
          <button type="button" className="secondary" onClick={onUseLocal} disabled={saving}>
            Use local models instead
          </button>
        )}
        <button type="button" className="secondary" onClick={onBack} disabled={saving}>
          Back
        </button>
      </div>
    </form>
  );
}
