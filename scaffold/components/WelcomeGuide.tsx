"use client";

/**
 * Two-step, first-visit welcome guide: (1) describe your company, with an
 * optional sample-company list that never touches the description textarea,
 * and (2) choose your model, pointing at the header Settings button. Shows
 * once ever per browser (lib/ui/welcomeGuidePrefs.ts); replayable from
 * Settings via useReplayWelcomeGuide(). Only auto-opens on the home page.
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
import { usePathname } from "next/navigation";
import { useDialogA11y } from "@/components/useDialogA11y";
import { SAMPLE_BLURBS, TEST_CASES } from "@/lib/testCases";
import {
  hasSeenWelcomeGuide,
  markWelcomeGuideSeen,
  shouldAutoStartWelcomeGuide,
} from "@/lib/ui/welcomeGuidePrefs";

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
  const pathname = usePathname();

  const openWelcomeGuide = useCallback(() => setOpen(true), []);
  const registerSampleHandler = useCallback((handler: SampleHandler) => {
    sampleHandlerRef.current = handler;
  }, []);

  // First visit this browser, ever, AND only on the home page — the only page
  // with a form to describe (step 1) and a sample handler registered (home's
  // IntakeForm, via useWelcomeGuideSampleHandler). Guarded by startedRef (this
  // mount) AND the localStorage "seen" flag (this browser, forever) — see
  // welcomeGuidePrefs.ts.
  useEffect(() => {
    if (pathname !== "/") return;
    if (!shouldAutoStartWelcomeGuide({ started: startedRef.current, seen: hasSeenWelcomeGuide() })) return;
    startedRef.current = true;
    // Mark seen NOW, not only on close — so a reload mid-guide can't re-trigger it.
    markWelcomeGuideSeen();
    setOpen(true);
  }, [pathname]);

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

type Step = 1 | 2;

function WelcomeGuideModal({ onDone }: { onDone: (sampleText: string | null) => void }) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const initialFocusRef = useRef<HTMLButtonElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const firstSampleRef = useRef<HTMLButtonElement>(null);
  const [step, setStep] = useState<Step>(1);
  const [samplesShown, setSamplesShown] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // At step 2, closing any way (X, Escape, backdrop) applies the selected
  // sample — the guide already told the user their pick would show up once
  // this guide closes, so a close here must mean the same thing Done does.
  const stepRef = useRef(step);
  stepRef.current = step;
  const selectedRef = useRef<string | null>(selectedId);
  selectedRef.current = selectedId;
  const close = useCallback(() => {
    const sample =
      stepRef.current === 2 ? TEST_CASES.find((tc) => tc.id === selectedRef.current)?.text ?? null : null;
    onDone(sample);
  }, [onDone]);
  useDialogA11y(dialogRef, close, initialFocusRef);

  // Move focus to the step heading whenever the step changes (skip the very
  // first render — useDialogA11y already placed initial focus on the Close
  // button then).
  const mountedRef = useRef(false);
  useEffect(() => {
    if (!mountedRef.current) {
      mountedRef.current = true;
      return;
    }
    headingRef.current?.focus();
  }, [step]);

  // Move focus into the sample list the instant it replaces the trigger
  // button, so the click doesn't drop focus to <body>.
  useEffect(() => {
    if (samplesShown) firstSampleRef.current?.focus();
  }, [samplesShown]);

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
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4 py-8" onClick={close}>
        <div
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-label="Welcome guide"
          className={panelClass}
          onClick={(e) => e.stopPropagation()}
        >
          <button ref={initialFocusRef} type="button" onClick={close} aria-label="Close" className={closeIconBtnClass}>
            <XIcon className="h-4 w-4" />
          </button>

          <p className={eyebrowClass}>
            Welcome — step {step} of 2
          </p>

          {step === 1 ? (
            <>
              <h2 ref={headingRef} tabIndex={-1} className={`${titleClass} focus-visible:outline-none`}>
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
                    {TEST_CASES.map((tc, i) => {
                      const isSelected = tc.id === selectedId;
                      return (
                        <li key={tc.id}>
                          <button
                            ref={i === 0 ? firstSampleRef : undefined}
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
              <h2 ref={headingRef} tabIndex={-1} className={`${titleClass} focus-visible:outline-none`}>
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
                  {selected.label} is selected — its results will show up on the page once this
                  guide closes.
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

/** Step 2's pulsing highlight around the header Settings button. */
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
        // Skip a zero-size or off-viewport candidate (e.g. the collapsed left
        // sidebar, which stays mounted off-screen for its slide transition) —
        // it has a real size but isn't the visible trigger. Deliberately does
        // NOT check for an inert ancestor: this guide's own dialog inerts
        // every other <body> child while open (useDialogA11y), which would
        // otherwise disqualify every candidate, including the visible one.
        if (r.width <= 0 && r.height <= 0) continue;
        if (r.right <= 0 || r.bottom <= 0 || r.left >= window.innerWidth || r.top >= window.innerHeight) continue;
        setRect(r);
        return;
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
