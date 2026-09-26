"use client";

import { useRef } from "react";
import { createPortal } from "react-dom";
import { useDialogA11y } from "@/components/useDialogA11y";
import { getAutoFillRequirements } from "@/lib/mockAuth";
import { allRegistrationsSatisfied } from "@/lib/apply/package";
import ApplicationChecklist from "@/components/ApplicationChecklist";
import type { Opportunity } from "@/lib/types";

/**
 * Replaces the (broken) assisted-apply flow's entry point with a plain,
 * read-only "how do I apply to this?" reference: what's due, what to
 * prepare, what to ask yourself, and what to do next — reusing the existing
 * `ApplicationChecklist` (D6), which is purely derived from the opportunity
 * record + the user's own self-reported Settings, no LLM call, no form, no
 * server round-trip, nothing to submit. There is nothing here to break.
 */
export default function HowToApplyModal({
  opportunity,
  onClose,
}: {
  opportunity: Opportunity;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeBtnRef = useRef<HTMLButtonElement>(null);
  useDialogA11y(dialogRef, onClose, closeBtnRef);

  // Read-only: whatever the user already saved in Settings, never written here.
  const satisfied = allRegistrationsSatisfied(getAutoFillRequirements());

  const panelClass =
    "relative max-h-[calc(100dvh-4rem)] w-full max-w-lg overflow-y-auto rounded-lg border border-structure-on-canvas bg-canvas p-6 text-foreground shadow-overlay";
  const eyebrowClass = "font-mono text-[11px] uppercase tracking-eyebrow text-structure-on-canvas";
  const titleClass = "mt-2 text-balance font-display text-[24px] font-bold leading-snug text-foreground";
  const bodyClass = "mt-3 text-pretty font-body text-[14px] leading-relaxed text-foreground";
  const closeTextBtnClass =
    "inline-flex min-h-[44px] items-center font-mono text-[11px] uppercase tracking-eyebrow text-foreground underline underline-offset-4 transition hover:text-structure-on-canvas focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-structure-on-canvas focus-visible:ring-offset-2";
  const closeIconBtnClass =
    "absolute right-3 top-3 rounded-sm p-1 text-foreground transition hover:bg-canvas-alt focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-structure-on-canvas focus-visible:ring-offset-2";

  // Portaled to document.body so the fixed overlay escapes the opportunity
  // card's stacking/overflow context and opens as a true viewport overlay.
  if (typeof document === "undefined") return null;
  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 px-4 py-8 sm:items-center"
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="how-to-apply-modal-title"
        aria-describedby="how-to-apply-modal-desc"
        className={panelClass}
        onClick={(e) => e.stopPropagation()}
      >
        <button ref={closeBtnRef} type="button" onClick={onClose} aria-label="Close" className={closeIconBtnClass}>
          <XIcon className="h-4 w-4" />
        </button>

        <p className={eyebrowClass}>How can I apply?</p>
        <h2 id="how-to-apply-modal-title" className={titleClass}>
          What you'll need
        </h2>
        <p id="how-to-apply-modal-desc" className={bodyClass}>
          Everything below is either read straight off this program's own listing, or generic
          guidance for this kind of opportunity. Confirm specifics on the official listing before
          you invest time in an application.
        </p>

        <ApplicationChecklist opportunity={opportunity} allRegistrationsSatisfied={satisfied} />

        <div className="mt-6 flex flex-wrap items-center gap-4">
          <button type="button" onClick={onClose} className={closeTextBtnClass}>
            Close
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function XIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}
