import { useCallback, useEffect, useState } from "react";
import type { InstallStatusEvent, InstallVersionPlan, OpenInstallTerminalResult, PrereqReport } from "../../../shared/ipc";
import ReportProblem from "../ReportProblem";

type LoadState =
  | { status: "loading" }
  | { status: "loaded"; report: PrereqReport }
  | { status: "error"; message: string };

const PLATFORM_LABEL: Record<string, string> = {
  darwin: "macOS",
  win32: "Windows",
  linux: "Linux",
};

interface PrereqCheckProps {
  /** Called once a Windows install reports it finished successfully. */
  onInstallComplete: () => void;
}

export default function PrereqCheck({ onInstallComplete }: PrereqCheckProps): React.JSX.Element {
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [terminalResult, setTerminalResult] = useState<OpenInstallTerminalResult | null>(null);
  const [openingTerminal, setOpeningTerminal] = useState(false);
  // Separate from openingTerminal: that one covers the brief IPC round-trip
  // to *launch* the installer; this covers the (much longer) wait for the
  // installer to actually finish, so the button can't be double-clicked
  // into starting a second, racing install. Only ever set on Windows — it's
  // the only platform that reports a real completion event (see below).
  const [waitingForInstall, setWaitingForInstall] = useState(false);
  // "Check for and install the latest version" (a release build only: a
  // development build installs main). Re-planned whenever it's toggled.
  const [checkForUpdates, setCheckForUpdates] = useState(true);
  const [plan, setPlan] = useState<InstallVersionPlan | null>(null);
  const [planning, setPlanning] = useState(false);

  useEffect(() => {
    let current = true;
    setPlanning(true);
    window.api
      .planInstallVersion(checkForUpdates)
      .then((p) => current && setPlan(p))
      .catch(() => current && setPlan(null))
      .finally(() => current && setPlanning(false));
    return () => {
      current = false;
    };
  }, [checkForUpdates]);

  const refreshPrereqs = useCallback((): void => {
    setState((prev) => (prev.status === "loaded" ? prev : { status: "loading" }));
    window.api
      .checkPrereqs()
      .then((report) => setState({ status: "loaded", report }))
      .catch((err: unknown) => {
        setState({
          status: "error",
          message: err instanceof Error ? err.message : String(err),
        });
      });
  }, []);

  useEffect(() => {
    refreshPrereqs();
  }, [refreshPrereqs]);

  // Once Windows's install actually finishes, move straight on to the
  // "Installation complete" screen — the console's "Done. Next steps:" is
  // otherwise the only sign it worked, and this screen's button would just
  // invite running the whole install again.
  useEffect(() => {
    return window.api.onInstallStatus((status: InstallStatusEvent) => {
      if (status.state === "running") {
        // A progress notice (e.g. "still waiting at a UAC prompt"), not an
        // outcome: show it, and keep the button disabled — the install is
        // still going, and a second click would start a concurrent one.
        if (status.message) {
          const notice = status.message;
          setTerminalResult((prev) => (prev ? { ...prev, message: notice } : prev));
        }
        return;
      }
      setWaitingForInstall(false);
      if (status.state === "done") {
        onInstallComplete();
      } else if (status.state === "error") {
        // Shown even if this screen didn't start the install (a reattached one), so it can be reported.
        const message = status.message ?? "The install didn't finish successfully.";
        setTerminalResult((prev) => (prev ? { ...prev, ok: false, message } : { ok: false, message, command: "", pollingStarted: false }));
      }
    });
  }, [onInstallComplete]);

  const handleOpenTerminal = (): void => {
    setOpeningTerminal(true);
    setTerminalResult(null);
    window.api
      .openInstallTerminal(checkForUpdates)
      .then((result) => {
        setTerminalResult(result);
        // Main process is the source of truth for whether a
        // terminal:install-status event will follow — not re-derived from
        // separately-fetched prereq-check state here, which could still be
        // "loading" (and so wrongly read as non-Windows) if this resolves
        // before that first check does.
        setWaitingForInstall(result.ok && result.pollingStarted);
      })
      .catch((err: unknown) => {
        setTerminalResult({
          ok: false,
          message: err instanceof Error ? err.message : String(err),
          command: "",
          pollingStarted: false,
        });
      })
      .finally(() => setOpeningTerminal(false));
  };

  const busy = openingTerminal || waitingForInstall;
  // Git and Node are both already there: the button only installs Granted
  // itself, so say that rather than "Open a terminal for me".
  const satisfied = state.status === "loaded" && state.report.allSatisfied;

  return (
    <main className="screen">
      <h1>Checking your computer</h1>
      <p className="subtitle">Granted needs Git and a recent version of Node.js installed.</p>

      {state.status === "loading" && <p>Checking git and Node.js…</p>}

      {state.status === "error" && (
        <>
          <p className="status-note">Couldn't run the check: {state.message}</p>
          <ReportProblem message={`Couldn't run the check: ${state.message}`} where="prereq-check" />
        </>
      )}

      {state.status === "loaded" && (
        <>
          <ul className="check-list" aria-label="Prerequisite check results">
            <ToolRow label="Git" result={state.report.git} />
            <ToolRow
              label={`Node.js (${state.report.nodeMajorMin}+ required)`}
              result={state.report.node}
              minMajor={state.report.nodeMajorMin}
            />
          </ul>
          <button type="button" className="link" onClick={refreshPrereqs} disabled={busy}>
            Check again
          </button>
          {satisfied && <p className="satisfied">✓ Node and Git dependencies satisfied.</p>}
        </>
      )}

      {plan?.pinned && (
        <div className="update-option">
          <label>
            <input
              type="checkbox"
              checked={checkForUpdates}
              onChange={(e) => setCheckForUpdates(e.target.checked)}
              disabled={busy}
            />
            Check for and install the latest version of Granted
          </label>
          <p className="detail" data-testid="install-version">
            {planning ? "Checking for a newer version…" : versionNote(plan)}
          </p>
        </div>
      )}

      <div className="actions">
        <button
          type="button"
          className={satisfied ? "primary" : "secondary"}
          onClick={handleOpenTerminal}
          disabled={busy || planning}
        >
          {openingTerminal
            ? "Opening…"
            : waitingForInstall
              ? "Installing…"
              : satisfied
                ? "Continue with installing the application"
                : "Open a terminal for me"}
        </button>
      </div>

      {terminalResult && (
        <div className="status-note">
          {terminalResult.message}
          {terminalResult.command && <code className="command">{terminalResult.command}</code>}
        </div>
      )}
      {terminalResult && !terminalResult.ok && <ReportProblem message={terminalResult.message} where="install" />}
    </main>
  );
}

/** What the install will set up, in words. */
function versionNote(plan: InstallVersionPlan): string {
  const own = `Granted ${plan.pinned} (this installer's version)`;
  if (!plan.checkForUpdates) return `${own} will be installed.`;
  if (plan.checkFailed) return `Couldn't check for updates, so ${own} will be installed.`;
  if (plan.ref !== plan.pinned) return `A newer version is available: Granted ${plan.ref} will be installed.`;
  return `Granted ${plan.pinned} is the latest version.`;
}

function ToolRow({
  label,
  result,
  minMajor,
}: {
  label: string;
  result: PrereqReport["git"] | PrereqReport["node"];
  minMajor?: number;
}): React.JSX.Element {
  const ok = result.present && (minMajor === undefined || (result.major ?? 0) >= minMajor);
  return (
    <li>
      <span className={`icon ${ok ? "ok" : "bad"}`}>{ok ? "✓" : "✗"}</span>
      <span>
        {label}
        {": "}
        {result.present
          ? `found (${result.version ?? "unknown version"})`
          : "not found"}
        {result.present && !ok && minMajor !== undefined && (
          <span className="detail"> — needs to be updated to {minMajor}+</span>
        )}
        {result.error && <span className="detail"> — {result.error}</span>}
      </span>
    </li>
  );
}
