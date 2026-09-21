"use client";

import { useRef } from "react";
import { createPortal } from "react-dom";
import { getAutoFillRequirements } from "@/lib/mockAuth";
import { useDialogA11y } from "@/components/useDialogA11y";
import { isFlagEnabled } from "@/lib/flags";

/**
 * FE-06 — Pro-upsell stub shown when someone clicks the locked "Auto Fill"
 * button on an opportunity card. Auto Fill itself doesn't exist yet (it's
 * blocked on API keys from the grant sites); this is honest about that and
 * doesn't take payment, invent stats, or claim a guarantee/affiliation
 * (R7.7). It reads what's already on file from the local Settings form
 * (lib/mockAuth.ts) so it can show which of the four requirements are done.
 */

type RequirementKey = "sam" | "uei" | "aor" | "ebiz";

const REQUIREMENTS: Array<{ key: RequirementKey; label: string; detail: string }> = [
  {
    key: "sam",
    label: "Active SAM.gov registration",
    detail: "The federal government's vendor registry — most awards can't be paid out without it.",
  },
  {
    key: "uei",
    label: "UEI (Unique Entity Identifier)",
    detail: "Your organization's federal ID number, issued when you register in SAM.gov.",
  },
  {
    key: "aor",
    label: "Authorized AOR (Authorized Organization Representative)",
    detail: "The person SAM.gov has on file as allowed to submit and sign applications for your organization.",
  },
  {
    key: "ebiz",
    label: "E-Biz POC delegation",
    detail:
      "Your Electronic Business Point of Contact has delegated AOR authority in SAM.gov — required before an AOR can act.",
  },
];

export default function AutoFillModal({
  onClose,
  onOpenSettings,
}: {
  onClose: () => void;
  onOpenSettings: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeBtnRef = useRef<HTMLButtonElement>(null);
  useDialogA11y(dialogRef, onClose, closeBtnRef);
  const commercial = isFlagEnabled("commercial_ui"); // hide "Pro plan" framing when off

  const reqs = getAutoFillRequirements();
  const satisfied: Record<RequirementKey, boolean> = {
    sam: reqs.samRegistered,
    uei: reqs.uei.trim().length > 0,
    aor: reqs.aorOnFile || reqs.aorName.trim().length > 0,
    ebiz: reqs.eBizPocOnFile,
  };

  const panelClass =
    "relative max-h-[calc(100dvh-4rem)] w-full max-w-lg overflow-y-auto rounded-lg border border-structure-on-canvas bg-canvas p-6 text-foreground shadow-overlay";

  const eyebrowClass = "font-mono text-[11px] uppercase tracking-eyebrow text-structure-on-canvas";

  const titleClass = "mt-2 text-balance font-display text-[24px] font-bold leading-snug text-foreground";

  const bodyClass = "mt-3 text-pretty font-body text-[14px] leading-relaxed text-foreground";

  const metClass = "text-structure-on-canvas";
  const mutedClass = "text-foreground";

  const reqLabelClass = "font-body text-[13px] font-medium text-foreground";
  const reqStatusClass = "font-body text-[13px] font-normal text-foreground";
  const reqDetailClass = "mt-0.5 text-pretty font-body text-[12px] leading-relaxed text-foreground";

  const settingsBtnClass =
    "inline-flex min-h-[44px] items-center rounded-sm border border-structure-on-canvas px-4 py-2 font-mono text-[11px] uppercase tracking-eyebrow text-structure-on-canvas transition hover:bg-structure hover:text-token-white active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-structure-on-canvas focus-visible:ring-offset-2";

  const closeTextBtnClass =
    "inline-flex min-h-[44px] items-center font-mono text-[11px] uppercase tracking-eyebrow text-foreground underline underline-offset-4 transition hover:text-structure-on-canvas focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-structure-on-canvas focus-visible:ring-offset-2";

  const closeIconBtnClass =
    "absolute right-3 top-3 rounded-sm p-1 text-foreground transition hover:bg-canvas-alt focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-structure-on-canvas focus-visible:ring-offset-2";

  const footnoteClass =
    "mt-6 border-t border-structure-on-canvas pt-4 text-pretty font-body text-[11px] leading-relaxed text-foreground";

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
        aria-labelledby="auto-fill-modal-title"
        aria-describedby="auto-fill-modal-desc"
        className={panelClass}
        onClick={(e) => e.stopPropagation()}
      >
        <button ref={closeBtnRef} type="button" onClick={onClose} aria-label="Close" className={closeIconBtnClass}>
          <XIcon className="h-4 w-4" />
        </button>

        <div className="flex items-center gap-2 pr-8">
          <LockIcon className="h-3.5 w-3.5" />
          <p className={eyebrowClass}>Not available yet</p>
        </div>

        <h2 id="auto-fill-modal-title" className={titleClass}>
          Auto Fill
        </h2>

        <p id="auto-fill-modal-desc" className={bodyClass}>
          Auto Fill would help you prepare federal applications — you always review and file them
          yourself. We're still finishing the integrations with each grant site, so it isn't live yet.
          {commercial ? " When it ships, it will be part of a Pro plan we're building toward." : ""} Nothing is
          submitted anywhere today.
        </p>

        <p className={bodyClass}>
          In the meantime, here's what it will need on file before it can act on your behalf:
        </p>

        <ul className="mt-4 space-y-3">
          {REQUIREMENTS.map((r) => (
            <li key={r.key} className="flex gap-3">
              <span className={satisfied[r.key] ? metClass : mutedClass} aria-hidden="true">
                {satisfied[r.key] ? "✓" : "○"}
              </span>
              <span className="min-w-0">
                <span className={reqLabelClass}>
                  {r.label}{" "}
                  <span className={reqStatusClass}>{satisfied[r.key] ? "(on file)" : "(not on file)"}</span>
                </span>
                <span className={`block ${reqDetailClass}`}>{r.detail}</span>
              </span>
            </li>
          ))}
        </ul>

        <div className="mt-6 flex flex-wrap items-center gap-4">
          <button type="button" onClick={onOpenSettings} className={settingsBtnClass}>
            Add these in Settings
          </button>
          <button type="button" onClick={onClose} className={closeTextBtnClass}>
            Close
          </button>
        </div>

        <p className={footnoteClass}>
          This is a preview — no application is ever submitted from this screen. You always review
          and file it yourself.
        </p>
      </div>
    </div>,
    document.body,
  );
}

function LockIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`${className ?? ""} text-structure-on-canvas`.trim()}
      aria-hidden="true"
    >
      <rect x="3" y="7" width="10" height="7" rx="1.5" />
      <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" />
    </svg>
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
