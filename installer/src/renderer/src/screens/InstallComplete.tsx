// Explicit React import: this file's JSX must transpile correctly both under
// electron-vite's build (automatic JSX runtime, per tsconfig.web.json's
// "jsx": "react-jsx", which doesn't need this) AND under the plain `tsx`-run
// node:test runner this screen's component test uses, which resolves
// installer/tsconfig.json — a references-only file with no jsx setting — and
// so falls back to the classic runtime, needing `React` in scope to call
// React.createElement. The same convention, for the same reason, as the app's
// own components (see scaffold/components/ApplicationChecklist.tsx).
import React, { useCallback, useEffect, useState } from "react";
import type { GrantedSetupState, OpenIn, ShortcutChoice, TaskStatusEvent } from "../../../shared/ipc";
import ReportProblem from "../ReportProblem";

/**
 * Shown once the install finishes. Offers to do the README's "Next steps"
 * for the user — configure .env.local (an API key for scoring, or the fully-local
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
  // macOS: ticked = also put the ~/Applications launcher in the Dock. Ticked
  // by default, matching Windows, where the Desktop and Start-menu shortcuts
  // are offered ticked rather than opt-in.
  const [addToDock, setAddToDock] = useState(true);
  const [launcherNote, setLauncherNote] = useState<{ ok: boolean; message: string } | null>(null);
  const [launcherMade, setLauncherMade] = useState(false);
  const [launcherInDock, setLauncherInDock] = useState(false);

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

  // macOS: creates ~/Applications/Granted.app (once — it's the same bundle if
  // the user goes Back and continues again), and adds it to the Dock if the
  // box is ticked. The launcher itself is NOT optional: the work order makes
  // only the Dock placement a choice, so this runs with the box unticked too
  // and just leaves the Dock alone. Never blocks continuing, like shortcuts:
  // a failure is only noted.
  const applyLauncher = async (): Promise<void> => {
    if (!setup?.launcherAvailable || launcherMade) return;
    const result = await window.api.createLauncher({ addToDock }).catch(() => ({
      ok: false,
      message: "Couldn't add Granted to your Applications folder. You can still open Granted from here.",
      launcherPath: null,
      inDock: false,
    }));
    setLauncherNote({ ok: result.ok, message: result.message });
    if (result.ok) {
      setLauncherMade(true);
      setLauncherInDock(result.inDock);
    }
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
      .then(applyLauncher)
      .catch(() => setShortcutsNote({ ok: false, message: "Couldn't add the Granted shortcut(s)." }))
      .finally(() => {
        setApplying(false);
        next();
      });
  };

  const handleYes = (): void =>
    continueWith(() => {
      // Already configured on an earlier run — nothing to ask, just start it.
      if (setup?.hostedKeysSet || setup?.localConfigured || setup?.settingsProviderSet) start();
      else setStep({ id: "choose" });
    });

  const installDir = setup?.installDir ?? "your granted folder";
  // Everything about running in the background is worded per platform: on
  // Windows it's a tray icon by the clock in a PowerShell-run install, on
  // macOS a menu-bar icon over a LaunchAgent, with no PowerShell anywhere.
  const isMac = setup?.platform === "darwin";
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
            Couldn't find Granted in {installDir} — the install may not have finished. Check the{" "}
            {isMac ? "Terminal" : "PowerShell"} window it ran in for errors.
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
          {setup?.launcherAvailable && !launcherMade && <AddToDockOption addToDock={addToDock} onChange={setAddToDock} />}
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
      {launcherNote && step.id !== "ask" && (
        <div className={`status-note${launcherNote.ok ? "" : " error"}`}>{launcherNote.message}</div>
      )}
      {openInNote && step.id !== "ask" && <div className="status-note error">{openInNote}</div>}

      {step.id === "choose" && (
        <>
          <p className="question">How should Granted run?</p>
          <div className="choices">
            <button type="button" className="choice" onClick={() => setStep({ id: "keys" })}>
              <strong>Use my API keys</strong>
              <span>
                Fastest. Search runs on this computer with no key; one OpenAI or Claude key does the scoring.
              </span>
            </button>
            <button type="button" className="choice" onClick={runLocalSetup}>
              <strong>Run everything on this computer</strong>
              <span>
                No API keys, works offline. Downloads an AI model for the scoring (several GB) through Ollama and can
                take up to half an hour the first time.
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
        ) : isMac ? (
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
          {step.background && isMac ? (
            <div className="status-note">
              {step.message ?? openedText(step.openedIn)} It's at <code>{step.url}</code> and keeps running in
              the background — look for the <strong>Granted icon</strong> in the menu bar at the top of your screen.
              Click it to open Granted again, to see its log, or to quit it.
              {launcherMade && (
                <>
                  {" "}
                  Next time, open it from <strong>Granted</strong> in your Applications folder
                  {launcherInDock && <> or from the Dock</>}.
                </>
              )}
            </div>
          ) : step.background ? (
            <div className="status-note">
              {step.message ?? openedText(step.openedIn)} It's at <code>{step.url}</code> and keeps running in
              the background — look for the <strong>Granted icon</strong> by the clock (it may be under the ^ arrow).
              Right-click it to open Granted again or to quit it.
              {shortcutPlaces.length > 0 && <> Next time, open it from the Granted shortcut {shortcutPlaces.join(" or ")}.</>}
            </div>
          ) : isMac ? (
            <div className="status-note">
              {step.message ?? openedText(step.openedIn)} It's at <code>{step.url}</code> and keeps running in the
              background until you quit it or restart your Mac. This copy of Granted is too old to show a menu-bar
              icon: to stop it, quit the <code>node</code> process in Activity Monitor, or update Granted.
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
          {/* macOS's equivalent of the shortcut line: the ~/Applications
              launcher, and the Dock if the box was left ticked. */}
          {launcherMade && (
            <p>
              Open Granted any time from <strong>Granted</strong> in your Applications folder
              {launcherInDock && <> or from the Granted icon in the Dock</>}. The first time, set it up first (your API
              keys, or fully local) with:
            </p>
          )}
          {shortcutPlaces.length === 0 && !launcherMade && (
            <p>To open Granted later, run these in {isMac ? "Terminal" : "PowerShell"}:</p>
          )}
          <code className="command">{`cd ${isMac ? `"${installDir}/scaffold"` : `"${installDir}\\scaffold"`}
npm run setup                  # an OpenAI or Claude key for scoring (each optional), or
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
          <ReportProblem message={step.message} where="open-granted" />
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

/**
 * macOS's counterpart of the Windows shortcut checkboxes: "Add Granted to the
 * Dock", ticked by default (Windows offers its Desktop and Start-menu
 * shortcuts the same way, rather than opt-in).
 *
 * Only the Dock placement is a choice. The ~/Applications/Granted.app
 * launcher is created either way — which is what the label and its
 * description say, so an unticked box can't be read as "don't add Granted
 * anywhere". A `.app` bundle and a Dock tile are both labelled by macOS
 * itself, so neither needs an accessibility label of its own; this checkbox
 * does, hence the aria-description, the same as the own-window box above it.
 *
 * Exported so it can be rendered on its own in a test (the screen's own state
 * only arrives through an effect, which renderToStaticMarkup never runs).
 */
export function AddToDockOption({
  addToDock,
  onChange,
}: {
  addToDock: boolean;
  onChange: (value: boolean) => void;
}): React.JSX.Element {
  const description =
    "Granted is added to your Applications folder either way. Untick to leave your Dock as it is.";
  return (
    <label className="open-in-option" title={description}>
      <input
        type="checkbox"
        checked={addToDock}
        onChange={(e) => onChange(e.target.checked)}
        aria-description={description}
      />
      Add Granted to the Dock
    </label>
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
        Search runs on this computer with a built-in model and needs no key. Granted needs one key to score the grants
        it finds: OpenAI or Anthropic (Claude). Either is enough; with both, Claude does the scoring. Other providers
        (Gemini, Groq and more) can be set up in Settings → Model once Granted is open. Keys are saved only on this
        computer, in Granted's .env.local file.
      </p>
      <label>
        OpenAI API key <span className="detail">(optional — scores the matches; platform.openai.com/api-keys)</span>
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
        <span className="detail">(optional — Claude scores the matches; console.anthropic.com/settings/keys)</span>
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
