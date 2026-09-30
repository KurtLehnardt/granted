import { useEffect, useState } from "react";
import type { OpenInstallTerminalResult, PrereqReport } from "../../../shared/ipc";

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

  useEffect(() => {
    let cancelled = false;
    window.api
      .checkPrereqs()
      .then((report) => {
        if (!cancelled) setState({ status: "loaded", report });
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setState({
            status: "error",
            message: err instanceof Error ? err.message : String(err),
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleOpenTerminal = (): void => {
    setOpeningTerminal(true);
    setTerminalResult(null);
    window.api
      .openInstallTerminal()
      .then((result) => setTerminalResult(result))
      .catch((err: unknown) => {
        setTerminalResult({
          ok: false,
          message: err instanceof Error ? err.message : String(err),
          command: "",
        });
      })
      .finally(() => setOpeningTerminal(false));
  };

  return (
    <main className="screen">
      <h1>Checking your computer</h1>
      <p className="subtitle">Granted needs Git and a recent version of Node.js installed.</p>

      {state.status === "loading" && <p>Checking git and Node.js…</p>}

      {state.status === "error" && (
        <p className="status-note">Couldn't run the check: {state.message}</p>
      )}

      {state.status === "loaded" && (
        <ul className="check-list" aria-label="Prerequisite check results">
          <ToolRow label="Git" result={state.report.git} />
          <ToolRow
            label={`Node.js (${state.report.nodeMajorMin}+ required)`}
            result={state.report.node}
            minMajor={state.report.nodeMajorMin}
          />
        </ul>
      )}

      <div className="actions">
        <button
          type="button"
          className="secondary"
          onClick={handleOpenTerminal}
          disabled={openingTerminal}
        >
          {openingTerminal ? "Opening…" : "Open a terminal for me"}
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
