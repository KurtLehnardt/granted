import { useCallback, useEffect, useState } from "react";
import type { InstallStatusEvent, OpenInstallTerminalResult, PrereqReport } from "../../../shared/ipc";

type LoadState =
  | { status: "loading" }
  | { status: "loaded"; report: PrereqReport }
  | { status: "error"; message: string };

const PLATFORM_LABEL: Record<string, string> = {
  darwin: "macOS",
  win32: "Windows",
  linux: "Linux",
};

export default function PrereqCheck(): React.JSX.Element {
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [terminalResult, setTerminalResult] = useState<OpenInstallTerminalResult | null>(null);
  const [openingTerminal, setOpeningTerminal] = useState(false);
  // Separate from openingTerminal: that one covers the brief IPC round-trip
  // to *launch* the installer; this covers the (much longer) wait for the
  // installer to actually finish, so the button can't be double-clicked
  // into starting a second, racing install. Only ever set on Windows — it's
  // the only platform that reports a real completion event (see below).
  const [waitingForInstall, setWaitingForInstall] = useState(false);

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

  // Automatically re-checks once Windows's install actually finishes, so a
  // user who just watched "Done." in the console doesn't come back to this
  // screen and still see two stale red marks with no way to clear them.
  useEffect(() => {
    return window.api.onInstallStatus((status: InstallStatusEvent) => {
      setWaitingForInstall(false);
      if (status.state === "done") {
        setTerminalResult((prev) => (prev ? { ...prev, message: "Install finished — re-checking…" } : prev));
        refreshPrereqs();
      } else if (status.state === "error") {
        setTerminalResult((prev) =>
          prev ? { ...prev, ok: false, message: status.message ?? "The install didn't finish successfully." } : prev,
        );
      }
    });
  }, [refreshPrereqs]);

  const handleOpenTerminal = (): void => {
    setOpeningTerminal(true);
    setTerminalResult(null);
    window.api
      .openInstallTerminal()
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

  return (
    <main className="screen">
      <h1>Checking your computer</h1>
      <p className="subtitle">Granted needs Git and a recent version of Node.js installed.</p>

      {state.status === "loading" && <p>Checking git and Node.js…</p>}

      {state.status === "error" && (
        <p className="status-note">Couldn't run the check: {state.message}</p>
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
        </>
      )}

      <div className="actions">
        <button
          type="button"
          className="secondary"
          onClick={handleOpenTerminal}
          disabled={busy}
        >
          {openingTerminal ? "Opening…" : waitingForInstall ? "Installing…" : "Open a terminal for me"}
        </button>
      </div>

      {terminalResult && (
        <div className="status-note">
          {terminalResult.message}
          {terminalResult.command && <code className="command">{terminalResult.command}</code>}
        </div>
      )}
    </main>
  );
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
