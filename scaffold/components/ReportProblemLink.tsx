"use client";

import React, { useEffect, useState } from "react";
import { browserIssueUrl } from "@/lib/errorLog/client";

/**
 * Shown under every user-facing error: its correlation id, and "Report this
 * problem" — a GitHub "new issue" page in the user's browser, pre-filled with
 * this error (sanitized), the recent log, the version, OS, provider type and
 * search mode. The user reviews it and submits it with their own account.
 *
 * The link works straight away (built in the browser from this error alone)
 * and is upgraded to the server's fuller one a moment later, once the error
 * has reached the log. `initialUrl` is the hermetic test seam (no network).
 */
export const REPORT_LINK_CLASS =
  "font-mono text-[11px] uppercase tracking-eyebrow text-foreground underline decoration-dotted underline-offset-2 transition hover:text-structure-on-canvas focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-structure-on-canvas focus-visible:ring-offset-2";

export default function ReportProblemLink({
  errorId,
  area,
  message,
  initialUrl,
}: {
  errorId: string;
  area?: string;
  message?: string;
  initialUrl?: string;
}) {
  const [url, setUrl] = useState(() => initialUrl ?? browserIssueUrl({ errorId, area, message }));

  useEffect(() => {
    if (initialUrl) return;
    setUrl(browserIssueUrl({ errorId, area, message }));
    let live = true;
    // A moment's wait: the browser's own report of this error is still on its way to the log.
    const timer = setTimeout(() => {
      fetch(`/api/logs?issue=${encodeURIComponent(errorId)}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((s: { issueUrl?: unknown; issueIncluded?: unknown } | null) => {
          if (live && s && typeof s.issueUrl === "string" && typeof s.issueIncluded === "number" && s.issueIncluded > 0) setUrl(s.issueUrl);
        })
        .catch(() => {});
    }, 600);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [errorId, area, message, initialUrl]);

  return (
    <span className="inline-flex flex-wrap items-center gap-x-3 gap-y-1" data-testid="error-report">
      <span className="font-mono text-[11px] text-foreground opacity-70">
        Error ID <span data-testid="error-id">{errorId}</span>
      </span>
      <a href={url} target="_blank" rel="noopener noreferrer" className={REPORT_LINK_CLASS}>
        Report this problem
      </a>
    </span>
  );
}
