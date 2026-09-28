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
  sampleLoading: boolean;
  setSampleLoading: (loading: boolean) => void;
};

const WelcomeGuideContext = createContext<WelcomeGuideContextValue | null>(null);

function useWelcomeGuideContext(): WelcomeGuideContextValue {
  const ctx = useContext(WelcomeGuideContext);
  return (
    ctx ?? {
      openWelcomeGuide: () => {},
      registerSampleHandler: () => {},
      sampleLoading: false,
      setSampleLoading: () => {},
    }
  );
}

/** Settings' "Replay welcome guide" button calls this. */
export function useReplayWelcomeGuide(): () => void {
  return useWelcomeGuideContext().openWelcomeGuide;
}

/** IntakeForm registers how to run a sample (never via the textarea) and whether it's busy. */
export function useWelcomeGuideSampleHandler(
  handler: (description: string) => void,
  busy: boolean,
): void {
  const { registerSampleHandler, setSampleLoading } = useWelcomeGuideContext();
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  useEffect(() => {
    registerSampleHandler((description) => handlerRef.current(description));
    return () => registerSampleHandler(null);
  }, [registerSampleHandler]);
  useEffect(() => {
    setSampleLoading(busy);
    return () => setSampleLoading(false);
  }, [busy, setSampleLoading]);
}

/** Mount once (app/layout.tsx) so the guide is reachable/replayable from anywhere. */
export function WelcomeGuideProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [sampleLoading, setSampleLoading] = useState(false);
  const startedRef = useRef(false);
  const sampleHandlerRef = useRef<SampleHandler>(null);
  const pathname = usePathname();

  const openWelcomeGuide = useCallback(() => setOpen(true), []);
  const registerSampleHandler = useCallback((handler: SampleHandler) => {
    sampleHandlerRef.current = handler;
  }, []);

  // Home page only: it has the form and the registered sample handler.
  useEffect(() => {
    if (pathname !== "/") return;
    if (!shouldAutoStartWelcomeGuide({ started: startedRef.current, seen: hasSeenWelcomeGuide() })) return;
    startedRef.current = true;
    markWelcomeGuideSeen();
    setOpen(true);
  }, [pathname]);

  const handleDone = useCallback((sampleText: string | null) => {
    markWelcomeGuideSeen();
    setOpen(false);
    if (sampleText) sampleHandlerRef.current?.(sampleText);
  }, []);

  return (
    <WelcomeGuideContext.Provider
      value={{ openWelcomeGuide, registerSampleHandler, sampleLoading, setSampleLoading }}
    >
      {children}
      {open && <WelcomeGuideModal onDone={handleDone} sampleLoading={sampleLoading} />}
    </WelcomeGuideContext.Provider>
  );
}

type Step = 1 | 2;

function WelcomeGuideModal({
  onDone,
  sampleLoading,
}: {
  onDone: (sampleText: string | null) => void;
  sampleLoading: boolean;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const initialFocusRef = useRef<HTMLButtonElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const firstSampleRef = useRef<HTMLButtonElement>(null);
  const [step, setStep] = useState<Step>(1);
  const [samplesShown, setSamplesShown] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // At step 2 any close (X, Escape, backdrop) applies the pick, same as Done.
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

  // Focus the heading on step change; useDialogA11y handles initial focus.
  const mountedRef = useRef(false);
  useEffect(() => {
    if (!mountedRef.current) {
      mountedRef.current = true;
      return;
    }
    headingRef.current?.focus();
  }, [step]);

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
                  {sampleLoading && (
                    <p className="mt-2 font-mono text-[11px] uppercase tracking-eyebrow text-structure-on-canvas">
                      Available when your current search finishes
                    </p>
                  )}
                  <ul className="mt-3 flex flex-col gap-2">
                    {TEST_CASES.map((tc, i) => {
                      const isSelected = tc.id === selectedId;
                      return (
                        <li key={tc.id}>
                          <button
                            ref={i === 0 ? firstSampleRef : undefined}
                            type="button"
                            disabled={sampleLoading}
                            onClick={() => setSelectedId(isSelected ? null : tc.id)}
                            aria-pressed={isSelected}
                            className={`${sampleItemClass} ${
                              isSelected
                                ? "border-structure-on-canvas bg-structure text-token-white"
                                : "border-structure-on-canvas bg-canvas hover:bg-structure hover:text-token-white"
                            } disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-canvas disabled:hover:text-foreground`}
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
                there. Prefer a cloud model? Open Settings → Model, choose Cloud (Claude), and
                paste your Anthropic API key.
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
    // Several [data-tour="settings"] exist; pick the first visible, on-screen one.
    // No inert check: this dialog inerts everything else while open.
    const measure = () => {
      const candidates = Array.from(document.querySelectorAll<HTMLElement>('[data-tour="settings"]'));
      for (const el of candidates) {
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) continue;
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
