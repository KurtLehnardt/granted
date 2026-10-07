"use client";

import React, { useEffect, useState } from "react";
import { clientMessageOf, reportClientError } from "@/lib/errorLog/client";
import ReportProblemLink, { REPORT_LINK_CLASS } from "@/components/ReportProblemLink";

/**
 * What a React error boundary shows (app/error.tsx, app/global-error.tsx):
 * the crash goes to the error log, and the user gets its id, "Report this
 * problem" and "Try again".
 */
export default function CrashNotice({ error, reset, initialErrorId }: { error: Error; reset: () => void; initialErrorId?: string }) {
  const [errorId, setErrorId] = useState<string | null>(initialErrorId ?? null);

  useEffect(() => {
    if (!initialErrorId) setErrorId(reportClientError("react", error));
  }, [error, initialErrorId]);

  return (
    <div role="alert" className="mx-auto mt-16 max-w-xl rounded-r-sm border-l-2 border-error bg-canvas-alt px-4 py-3 font-body text-sm text-foreground">
      <p className="font-display text-lg">Something went wrong on this page.</p>
      <p className="mt-1 opacity-80">Granted hit an error it didn&apos;t expect. Trying again usually works.</p>
      <div className="mt-3 flex flex-wrap items-center gap-4">
        <button type="button" onClick={reset} className={REPORT_LINK_CLASS}>
          Try again
        </button>
        {errorId && <ReportProblemLink errorId={errorId} area="react" message={clientMessageOf(error)} />}
      </div>
    </div>
  );
}
