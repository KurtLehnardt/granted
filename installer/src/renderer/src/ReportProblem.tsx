// Explicit React import, for the reason InstallComplete.tsx's own comment
// gives: that screen's component test renders this component too, through the
// plain `tsx` runner, which transpiles JSX with the classic runtime.
import React, { useState } from "react";

/**
 * "Report this problem", under an error the installer shows: opens a
 * pre-filled GitHub issue (the error, sanitized, plus version and OS) in the
 * user's browser. The main process builds and sanitizes the link.
 */
export default function ReportProblem({ message, where }: { message: string; where: string }): React.JSX.Element {
  const [note, setNote] = useState<string | null>(null);
  const report = (): void => {
    window.api
      .reportProblem(message, where)
      .then((r) => setNote(r.message))
      .catch(() => setNote("Couldn't open your browser for the problem report."));
  };
  return (
    <div className="report-problem">
      <button type="button" className="link" onClick={report}>
        Report this problem
      </button>
      {note && <span className="detail"> {note}</span>}
    </div>
  );
}
