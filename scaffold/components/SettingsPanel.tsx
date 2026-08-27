"use client";

import { useRef } from "react";
import { useDialogA11y } from "@/components/useDialogA11y";
import SettingsForm from "@/components/SettingsForm";

/**
 * FE-06 — Settings panel, reached via the hamburger menu (AppMenu.tsx) or the
 * Auto Fill modal's "Add these in Settings" link. Holds the "Auto-fill
 * requirements" form: the same SAM.gov/UEI/AOR/E-Biz POC facts the (stubbed)
 * Auto Fill feature and R8.1 eligibility screening both care about.
 *
 * FE-07 — the form body itself now lives in the reusable <SettingsForm/>
 * (shared with the left-sidebar's Settings section). This dialog is unchanged:
 * it renders the same eyebrow/title/note + close chrome and the same form
 * inside, with the "Close" button preserved by passing `onClose` through.
 *
 * Token-styled (CON-02 60/30/10) — the design revamp made these the default.
 *
 * Persisted to localStorage only (lib/mockAuth.ts) — nothing here is sent
 * anywhere, and PLT-01's "Delete my data" clears it along with everything
 * else, since it lives under the same STORAGE_KEYS map.
 */
export default function SettingsPanel({ onClose }: { onClose: () => void }) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeBtnRef = useRef<HTMLButtonElement>(null);
  useDialogA11y(dialogRef, onClose, closeBtnRef);

  // Modal: elevated surface (rounded + overlay shadow) with a definition border
  // over the scrim.
  const panelClass =
    "relative max-h-[85vh] w-full max-w-md overflow-y-auto rounded-lg border border-structure-on-canvas bg-canvas p-6 text-foreground shadow-overlay";
  const eyebrowClass = "font-mono text-[11px] uppercase tracking-eyebrow text-structure-on-canvas";
  const titleClass = "mt-2 text-balance font-display text-[22px] font-bold leading-snug text-foreground";
  const noteClass = "mt-2 text-pretty font-body text-[12px] leading-relaxed text-foreground";
  const closeIconBtnClass =
    "absolute right-3 top-3 rounded-sm p-1 text-foreground transition hover:bg-canvas-alt focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-structure-on-canvas focus-visible:ring-offset-2";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4 py-8"
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-panel-title"
        className={panelClass}
        onClick={(e) => e.stopPropagation()}
      >
        <button ref={closeBtnRef} type="button" onClick={onClose} aria-label="Close" className={closeIconBtnClass}>
          <XIcon className="h-4 w-4" />
        </button>

        <p className={eyebrowClass}>Settings</p>
        <h2 id="settings-panel-title" className={titleClass}>
          Auto-fill requirements
        </h2>
        <p className={noteClass}>
          These values are stored on this device only (your browser's local storage) — never sent
          to a server. Recording them here doesn't submit anything or turn Auto Fill on; it just
          lets the Auto Fill preview show what's already in place.
        </p>

        <SettingsForm onClose={onClose} />
      </div>
    </div>
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
