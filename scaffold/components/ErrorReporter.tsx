"use client";

import { useEffect } from "react";
import { reportClientError } from "@/lib/errorLog/client";

/**
 * Catches what nothing else does: uncaught errors (window.onerror) and
 * unhandled promise rejections anywhere in the page go to the local error
 * log. No UI. Mounted once, in the root layout.
 */

/** Browser noise that isn't a Granted problem. */
export function isIgnorableError(message: string, filename?: string): boolean {
  if (/^ResizeObserver loop/i.test(message)) return true;
  if (/^Script error\.?$/i.test(message)) return true; // a cross-origin script: no details to report
  if (filename && /^(chrome|moz|safari)-extension:|^edge:/i.test(filename)) return true;
  if (/AbortError|The user aborted a request|signal is aborted/i.test(message)) return true;
  return false;
}

export default function ErrorReporter() {
  useEffect(() => {
    const onError = (event: ErrorEvent) => {
      const message = event.error instanceof Error ? event.error.message : event.message || "";
      if (isIgnorableError(message, event.filename)) return;
      reportClientError("page", event.error ?? event.message);
    };
    const onRejection = (event: PromiseRejectionEvent) => {
      const reason = event.reason;
      const message = reason instanceof Error ? `${reason.name}: ${reason.message}` : String(reason ?? "");
      if (isIgnorableError(message)) return;
      reportClientError("page", reason ?? "Unhandled promise rejection");
    };
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, []);
  return null;
}
