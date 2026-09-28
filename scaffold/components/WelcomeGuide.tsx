"use client";

/**
 * WelcomeGuide.tsx — the two-step, first-visit welcome guide (replaces the old
 * anchored coach-mark WelcomeTour.tsx).
 *
 * A real modal dialog (not a spotlight popover): it walks a first-time visitor
 * through exactly two things —
 *
 *   1. Describe your company — explains the form below, and offers an inline
 *      "Show sample companies" list. Picking one is remembered in state only;
 *      it never writes into the description textarea.
 *   2. Choose your model — points at the header Settings button (visually
 *      pulsed while this step is open) and explains the local Ollama model
 *      picker + the cloud (Claude) option via LLM_PROVIDER/ANTHROPIC_API_KEY.
 *
 * "Done" closes the guide and, only if a sample was picked, hands that
 * sample's description to whatever registered a sample handler (the home
 * page's IntakeForm, via runSample()) — served from the precomputed cache,
 * exactly like the old inline sample picker, and WITHOUT ever touching the
 * user's own description. Escape / the X at any step closes without applying
 * a sample.
 *
 * Auto-shows once ever per browser (localStorage — lib/ui/welcomeGuidePrefs.ts)
 * via WelcomeGuideProvider (mounted once in app/layout.tsx). A "Replay welcome
 * guide" button in Settings (SettingsForm.tsx) reopens it on demand through the
 * same context, regardless of the seen flag.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { useDialogA11y } from "@/components/useDialogA11y";
import { SAMPLE_BLURBS, TEST_CASES } from "@/lib/testCases";
import {
  hasSeenWelcomeGuide,
  markWelcomeGuideSeen,
  shouldAutoStartWelcomeGuide,
} from "@/lib/ui/welcomeGuidePrefs";

// ---------------------------------------------------------------------------
// Context — lets Settings (anywhere in the tree) reopen the guide, and lets
// the home page register how a picked sample should actually run a search,
// without prop-drilling either through the other.
// ---------------------------------------------------------------------------

type SampleHandler = ((description: string) => void) | null;

type WelcomeGuideContextValue = {
  openWelcomeGuide: () => void;
  registerSampleHandler: (handler: SampleHandler) => void;
};

const WelcomeGuideContext = createContext<WelcomeGuideContextValue | null>(null);

function useWelcomeGuideContext(): WelcomeGuideContextValue {
  const ctx = useContext(WelcomeGuideContext);
  // Outside the provider this is a harmless no-op, same posture as
  // useSettingsPanel() in AppMenu.tsx.
  return ctx ?? { openWelcomeGuide: () => {}, registerSampleHandler: () => {} };
}

/** Settings' "Replay welcome guide" button calls this. */
export function useReplayWelcomeGuide(): () => void {
  return useWelcomeGuideContext().openWelcomeGuide;
}

/**
 * The home page calls this once with a function that actually runs a search
 * for a sample's description (IntakeForm.runSample via a ref) — without ever
 * writing into the description textarea. Registration is cleared on unmount.
 */
export function useWelcomeGuideSampleHandler(handler: (description: string) => void): void {
  const { registerSampleHandler } = useWelcomeGuideContext();
  useEffect(() => {
    registerSampleHandler(handler);
    return () => registerSampleHandler(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [registerSampleHandler]);
}

/** Mount once (app/layout.tsx) so the guide is reachable/replayable from anywhere. */
export function WelcomeGuideProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const startedRef = useRef(false);
  const sampleHandlerRef = useRef<SampleHandler>(null);

  const openWelcomeGuide = useCallback(() => setOpen(true), []);
  const registerSampleHandler = useCallback((handler: SampleHandler) => {
    sampleHandlerRef.current = handler;
  }, []);

  // First visit this browser, ever. Guarded by startedRef (this mount) AND the
  // localStorage "seen" flag (this browser, forever) — see welcomeGuidePrefs.ts.
  useEffect(() => {
    if (!shouldAutoStartWelcomeGuide({ started: startedRef.current, seen: hasSeenWelcomeGuide() })) return;
    startedRef.current = true;
    // Mark seen NOW, not only on close — so a reload mid-guide can't re-trigger it.
    markWelcomeGuideSeen();
    setOpen(true);
  }, []);

  const handleDone = useCallback((sampleText: string | null) => {
    markWelcomeGuideSeen();
    setOpen(false);
    if (sampleText) sampleHandlerRef.current?.(sampleText);
  }, []);

  return (
    <WelcomeGuideContext.Provider value={{ openWelcomeGuide, registerSampleHandler }}>
      {children}
      {open && <WelcomeGuideModal onDone={handleDone} />}
    </WelcomeGuideContext.Provider>
  );
}

// ---------------------------------------------------------------------------
// The modal itself
// ---------------------------------------------------------------------------

type Step = 1 | 2;

function WelcomeGuideModal({ onDone }: { onDone: (sampleText: string | null) => void }) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const initialFocusRef = useRef<HTMLButtonElement>(null);
  const [step, setStep] = useState<Step>(1);
  const [samplesShown, setSamplesShown] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const close = useCallback(() => onDone(null), [onDone]);
  useDialogA11y(dialogRef, close, initialFocusRef);

  const selected = TEST_CASES.find((tc) => tc.id === selectedId) ?? null;

  const panelClass =
    "relative max-h-[85vh] w-full max-w-md overflow-y-auto rounded-lg border border-structure-on-canvas bg-canvas p-6 text-foreground shadow-overlay";
  const eyebrowClass = "font-mono text-[11px] uppercase tracking-eyebrow text-structure-on-canvas";
  const titleClass = "mt-2 text-balance font-display text-[22px] font-bold leading-snug text-foreground";
  const bodyClass = "mt-2 text-pretty font-body text-[14px] leading-relaxed text-foreground";
  const closeIconBtnClass =
    "absolute right-3 top-3 rounded-sm p-1 text-foreground transition hover:bg-canvas-alt focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-structure-on-canvas focus-visible:ring-offset-2";
  const primaryBtnClass =
    "inline-flex min-h-[44px] items-center rounded-sm bg-action px-4 py-2 font-mono text-[11px] uppercase tracking-eyebrow text-token-white transition hover:opacity-90 active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-structure-on-canvas focus-visible:ring-offset-2";
  const secondaryBtnClass =
    "inline-flex min-h-[44px] items-center rounded-sm border border-structure-on-canvas bg-canvas-alt px-4 py-2.5 font-mono text-[11px] uppercase tracking-eyebrow text-structure-on-canvas transition hover:bg-structure hover:text-token-white active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-structure-on-canvas focus-visible:ring-offset-2";
  const textBtnClass =
    "inline-flex min-h-[44px] items-center font-mono text-[11px] uppercase tracking-eyebrow text-foreground underline underline-offset-4 transition hover:text-structure-on-canvas focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-structure-on-canvas focus-visible:ring-offset-2";
  const sampleItemClass =
    "group flex min-h-[44px] w-full flex-col justify-center gap-0.5 rounded-sm border px-3.5 py-2.5 text-left transition active:scale-[0.99] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-structure-on-canvas focus-visible:ring-offset-2";

  if (typeof document === "undefined") return null;

  return createPortal(
    <>
      {step === 2 && <SettingsHighlight />}
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4 py-8">
        <div
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-label="Welcome guide"
          className={panelClass}
        >
          <button ref={initialFocusRef} type="button" onClick={close} aria-label="Close" className={closeIconBtnClass}>
            <XIcon className="h-4 w-4" />
          </button>

          <p className={eyebrowClass}>
            Welcome — step {step} of 2
          </p>

          {step === 1 ? (
            <>
              <h2 className={titleClass}>
                Describe your company
              </h2>
              <p className={bodyClass}>
                Fill out the form below with your company or research — what you build, who it's
                for, your size, and what funding would go toward. The more detail you give, the
                more specific your grant matches will be.
              </p>

              {!samplesShown ? (
                <button
                  type="button"
                  onClick={() => setSamplesShown(true)}
                  className={`${secondaryBtnClass} mt-4`}
                >
                  Show sample companies
                </button>
              ) : (
                <div className="mt-4">
                  <p className="text-pretty font-body text-[13px] leading-relaxed text-foreground">
                    These are fictional example companies with cached results — pick one to see how
                    it works, or just close this and fill out your own.
                  </p>
                  <ul className="mt-3 flex flex-col gap-2">
                    {TEST_CASES.map((tc) => {
                      const isSelected = tc.id === selectedId;
                      return (
                        <li key={tc.id}>
                          <button
                            type="button"
                            onClick={() => setSelectedId(isSelected ? null : tc.id)}
                            aria-pressed={isSelected}
                            className={`${sampleItemClass} ${
                              isSelected
                                ? "border-structure-on-canvas bg-structure text-token-white"
                                : "border-structure-on-canvas bg-canvas hover:bg-structure hover:text-token-white"
                            }`}
                          >
                            <span
                              className={`font-mono text-[12px] uppercase tracking-eyebrow ${
                                isSelected ? "text-token-white" : "text-structure-on-canvas group-hover:text-token-white"
                              }`}
                            >
                              {tc.label}
                              {isSelected ? " ✓" : ""}
                            </span>
                            <span
                              className={`text-pretty font-body text-[13px] leading-relaxed ${
                                isSelected ? "text-token-white" : "text-foreground group-hover:text-token-white"
                              }`}
                            >
                              {SAMPLE_BLURBS[tc.id]}
                            </span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              )}

              <div className="mt-5 flex items-center justify-end">
                <button type="button" onClick={() => setStep(2)} className={primaryBtnClass}>
                  Next
                </button>
              </div>
            </>
          ) : (
            <>
              <h2 className={titleClass}>
                Choose your model
              </h2>
              <p className={bodyClass}>
                Open <strong>Settings</strong> (the highlighted button) to pick your model. If you're
                running a local model, every installed Ollama model shows up in the model picker
                there. Prefer a cloud model? Set{" "}
                <code className="font-mono text-[13px]">LLM_PROVIDER=anthropic</code> and{" "}
                <code className="font-mono text-[13px]">ANTHROPIC_API_KEY</code> in{" "}
                <code className="font-mono text-[13px]">scaffold/.env.local</code> to use Claude
                instead.
              </p>

              {selected && (
                <p className="mt-3 rounded-sm border border-structure-on-canvas bg-canvas-alt px-3 py-2 text-pretty font-body text-[12px] leading-relaxed text-foreground">
                  {selected.label} is selected — its results will show up on the page once you close
                  this guide.
                </p>
              )}

              <div className="mt-5 flex items-center justify-between gap-3">
                <button type="button" onClick={() => setStep(1)} className={textBtnClass}>
                  ‹ Back
                </button>
                <button
                  type="button"
                  onClick={() => onDone(selected?.text ?? null)}
                  className={primaryBtnClass}
                >
                  Done
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </>,
    document.body,
  );
}

// ---------------------------------------------------------------------------
// Step 2's pulsing highlight around the header Settings button
// ---------------------------------------------------------------------------

function SettingsHighlight() {
  const [rect, setRect] = useState<DOMRect | null>(null);

  useLayoutEffect(() => {
    // More than one [data-tour="settings"] can exist at once (desktop hamburger,
    // sidebar section header, collapsed sidebar re-open, mobile menu button) —
    // only one is ever actually visible at a given viewport/flag combination, so
    // pick the first with a non-zero rendered size.
    const measure = () => {
      const candidates = Array.from(document.querySelectorAll<HTMLElement>('[data-tour="settings"]'));
      for (const el of candidates) {
        const r = el.getBoundingClientRect();
        if (r.width > 0 || r.height > 0) {
          setRect(r);
          return;
        }
      }
      setRect(null);
    };
    measure();
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, []);

  if (!rect) return null;

  const style: CSSProperties = {
    position: "fixed",
    top: rect.top - 6,
    left: rect.left - 6,
    width: rect.width + 12,
    height: rect.height + 12,
    borderRadius: 10,
    boxShadow: "0 0 0 3px var(--color-action)",
    pointerEvents: "none",
    zIndex: 60,
  };

  return <div aria-hidden style={style} className="animate-pulse" />;
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
