"use client";

import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useDialogA11y } from "@/components/useDialogA11y";
import { isFlagEnabled } from "@/lib/flags";
import CompetitorResults from "@/components/CompetitorResults";
import demoCompetitorFixture from "@/data/demo-competitor-fastercontrol.json";
import { drainNdjson } from "@/lib/competitors/ndjson";
import type {
  CompetitorStreamEvent,
  GroundedAwardRecord,
  WebCompetitorProfile,
  AwardStats,
} from "@/lib/contracts/competitorAnalysis";

type LiveEvidence = {
  records: GroundedAwardRecord[];
  awardStats: AwardStats;
  webProfiles: WebCompetitorProfile[];
};

/** Compact whole-dollar USD for the live loading preview. */
function fmtUsd(n: number): string {
  return n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
}

/**
 * R5 — Competitor & Grant Intelligence, demo-first, with a LIVE personalized run
 * behind the default-OFF `r5_deep_analysis` flag. Free to use.
 *
 *   - flag OFF (default): "View example analysis" (the saved real example).
 *   - flag ON + a company profile: a primary "Run live analysis" that POSTs
 *     to /api/competitors for a real, personalized, grounded market brief — and
 *     falls back to the saved example WITH AN HONEST NOTE if the live run can't
 *     assemble enough grounded data (feasibility §6 honest-degradation posture).
 *
 * Every rendered brief (live or demo) is validated through the grounding
 * contract at the CompetitorResults boundary and never fabricates an award (R7.7).
 */

type View = "intro" | "loading" | "results";

export interface CompetitorAnalysisModalProps {
  onClose: () => void;
  /** The user's company, for a live personalized run. Absent → demo-only. */
  profile?: { description: string; keywords?: string[]; persona?: string };
  /** The target opportunity being viewed, for framing the live analysis. */
  opportunity?: { program?: string; agency?: string };
}

export default function CompetitorAnalysisModal({ onClose, profile, opportunity }: CompetitorAnalysisModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeBtnRef = useRef<HTMLButtonElement>(null);
  useDialogA11y(dialogRef, onClose, closeBtnRef);

  // Live run is offered when the default-OFF r5 flag is on and we actually have a
  // company description to ground the run in.
  const hasProfile = !!profile && typeof profile.description === "string" && profile.description.trim().length >= 20;
  const liveAvailable = isFlagEnabled("r5_deep_analysis") && hasProfile;

  const [view, setView] = useState<View>("intro");
  const [resultRaw, setResultRaw] = useState<unknown>(null);
  const [resultVariant, setResultVariant] = useState<"live" | "demo">("demo");
  const [note, setNote] = useState<string | null>(null);
  // Live streaming state (progressive loading view): the current stage + the
  // grounded evidence (real awards / stats / web competitors) as it's found.
  const [progress, setProgress] = useState<{ label: string; pct: number } | null>(null);
  const [evidence, setEvidence] = useState<LiveEvidence | null>(null);

  const showDemo = () => {
    setResultRaw(demoCompetitorFixture);
    setResultVariant("demo");
    setNote(null);
    setView("results");
  };

  const fallBackToDemo = (message: string) => {
    setResultRaw(demoCompetitorFixture);
    setResultVariant("demo");
    setNote(message);
    setView("results");
  };

  const runLive = async () => {
    if (!profile?.description) return;
    setView("loading");
    setNote(null);
    setProgress({ label: "Starting your analysis…", pct: 2 });
    setEvidence(null);
    try {
      const res = await fetch("/api/competitors", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          persona: profile.persona,
          description: profile.description,
          keywords: profile.keywords,
          opportunity,
        }),
      });
      // Validation errors return plain JSON (never a stream) — check res.ok first.
      if (!res.ok || !res.body) {
        fallBackToDemo(
          "Live analysis is temporarily unavailable — here's a saved example built from real public data instead.",
        );
        return;
      }

      // Read the NDJSON stream: stage/evidence events update the live loading
      // view; `result` renders the validated brief; `error` falls back to demo.
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let settled = false;
      for (;;) {
        const { value, done } = await reader.read();
        if (value) buffer += decoder.decode(value, { stream: true });
        const { objects, rest } = drainNdjson(buffer);
        buffer = rest;
        for (const obj of objects) {
          const evt = obj as CompetitorStreamEvent;
          if (evt.type === "stage") {
            setProgress({ label: evt.label, pct: evt.pct });
          } else if (evt.type === "evidence") {
            setEvidence({ records: evt.records, awardStats: evt.awardStats, webProfiles: evt.webProfiles });
          } else if (evt.type === "result") {
            settled = true;
            setResultRaw(evt.analysis);
            setResultVariant("live");
            setNote(null);
            setView("results");
          } else if (evt.type === "error") {
            settled = true;
            fallBackToDemo(
              evt.reason === "insufficient_evidence"
                ? "We couldn't find enough grounded public award data for a reliable live brief right now — here's a saved example built from real public data instead."
                : "Live analysis is temporarily unavailable — here's a saved example built from real public data instead.",
            );
          }
        }
        if (settled) return;
        if (done) break;
      }
      // Stream ended without a terminal event — degrade honestly.
      if (!settled) {
        fallBackToDemo(
          "Live analysis is temporarily unavailable — here's a saved example built from real public data instead.",
        );
      }
    } catch {
      fallBackToDemo(
        "Live analysis is temporarily unavailable — here's a saved example built from real public data instead.",
      );
    }
  };

  const isResults = view === "results";
  const panelClass = `relative max-h-[calc(100dvh-4rem)] w-full ${
    isResults ? "max-w-3xl" : "max-w-lg"
  } overflow-y-auto rounded-lg border border-structure-on-canvas bg-canvas p-6 text-foreground shadow-overlay`;

  const eyebrowClass = "font-mono text-[11px] uppercase tracking-eyebrow text-structure-on-canvas";
  const titleClass = "mt-2 text-balance font-display text-[24px] font-bold leading-snug text-foreground";
  const bodyClass = "mt-3 text-pretty font-body text-[14px] leading-relaxed text-foreground";
  const closeIconBtnClass =
    "absolute right-3 top-3 rounded-sm p-1 text-foreground transition hover:bg-canvas-alt focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-structure-on-canvas focus-visible:ring-offset-2";
  const footnoteClass =
    "mt-6 border-t border-structure-on-canvas pt-4 text-pretty font-body text-[11px] leading-relaxed text-foreground";

  const primaryBtnClass =
    "inline-flex min-h-[44px] items-center rounded-sm bg-action px-4 py-2 font-mono text-[11px] uppercase tracking-eyebrow text-token-white transition hover:opacity-90 active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-structure-on-canvas focus-visible:ring-offset-2";
  const secondaryBtnClass =
    "inline-flex min-h-[44px] items-center rounded-sm border border-structure-on-canvas px-4 py-2 font-mono text-[11px] uppercase tracking-eyebrow text-structure-on-canvas transition hover:bg-structure hover:text-token-white active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-structure-on-canvas focus-visible:ring-offset-2";
  const textBtnClass =
    "inline-flex min-h-[44px] items-center font-mono text-[11px] uppercase tracking-eyebrow text-foreground underline underline-offset-4 transition hover:text-structure-on-canvas focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-structure-on-canvas focus-visible:ring-offset-2";

  const recordCount = Array.isArray((demoCompetitorFixture as { records?: unknown[] }).records)
    ? (demoCompetitorFixture as { records: unknown[] }).records.length
    : 0;

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
        aria-labelledby="competitor-analysis-modal-title"
        aria-describedby="competitor-analysis-modal-desc"
        className={panelClass}
        onClick={(e) => e.stopPropagation()}
      >
        <button ref={closeBtnRef} type="button" onClick={onClose} aria-label="Close" className={closeIconBtnClass}>
          <XIcon className="h-4 w-4" />
        </button>

        {isResults ? (
          <div className="pr-6">
            <div className="flex items-center justify-between gap-2">
              <button type="button" onClick={() => setView("intro")} className={textBtnClass}>
                ‹ Back
              </button>
            </div>
            <h2 id="competitor-analysis-modal-title" className="sr-only">
              Competitor &amp; grant intelligence — {resultVariant === "live" ? "live analysis" : "example analysis"}
            </h2>
            <p id="competitor-analysis-modal-desc" className="sr-only">
              A competitor and grant market brief grounded in real public federal award data.
            </p>
            {note && (
              <div className="mt-3 rounded-sm border border-structure-on-canvas bg-canvas-alt px-3 py-2">
                <p className="text-pretty font-body text-[12px] leading-relaxed text-foreground">{note}</p>
              </div>
            )}
            <div className="mt-3">
              <CompetitorResults raw={resultRaw} variant={resultVariant} />
            </div>
          </div>
        ) : view === "loading" ? (
          <div className="py-6">
            <p className={eyebrowClass}>Analyzing</p>
            <h2 id="competitor-analysis-modal-title" className={titleClass}>
              Building your market brief…
            </h2>
            <p id="competitor-analysis-modal-desc" className={bodyClass}>
              Retrieving real public federal award records (USAspending, NIH RePORTER, NSF) and analyzing how
              funded companies positioned themselves — nothing is submitted on your behalf.
            </p>

            {/* Live progress: the current stage + a bar, updated as the pipeline streams. */}
            <div className="mt-6" aria-live="polite">
              <div className="flex items-center justify-between gap-3">
                <p className="font-mono text-[11px] uppercase tracking-eyebrow text-structure-on-canvas">
                  {progress?.label ?? "Working…"}
                </p>
                <Spinner />
              </div>
              <div
                className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-canvas-alt"
                role="progressbar"
                aria-valuenow={progress?.pct ?? 0}
                aria-valuemin={0}
                aria-valuemax={100}
              >
                <div
                  className="h-full rounded-full bg-structure transition-all duration-500 ease-out"
                  style={{ width: `${Math.max(4, Math.min(100, progress?.pct ?? 4))}%` }}
                />
              </div>
            </div>

            {/* Grounded evidence as it's found — REAL retrieval data (awards, stats,
                comparable companies), never a synthesized claim, so showing it early
                is honest. The cited brief still renders only after validation. */}
            {evidence && (
              <div className="mt-5 space-y-3 rounded-sm border border-structure-on-canvas bg-canvas-alt px-4 py-3 text-left">
                <div>
                  <p className="font-mono text-[11px] uppercase tracking-eyebrow text-structure-on-canvas">
                    Federal awards found
                  </p>
                  <p className="mt-1 font-body text-[13px] leading-relaxed text-foreground">
                    {evidence.awardStats.count} real award{evidence.awardStats.count === 1 ? "" : "s"}
                    {evidence.awardStats.minAmount != null && evidence.awardStats.maxAmount != null
                      ? ` · ${fmtUsd(evidence.awardStats.minAmount)}–${fmtUsd(evidence.awardStats.maxAmount)}`
                      : ""}
                  </p>
                </div>
                {evidence.webProfiles.length > 0 && (
                  <div>
                    <p className="font-mono text-[11px] uppercase tracking-eyebrow text-structure-on-canvas">
                      Comparable companies
                    </p>
                    <p className="mt-1 font-body text-[13px] leading-relaxed text-foreground">
                      {evidence.webProfiles.slice(0, 5).map((w) => w.company).join(" · ")}
                    </p>
                  </div>
                )}
              </div>
            )}
          </div>
        ) : (
          <>
            <h2 id="competitor-analysis-modal-title" className={titleClass}>
              Competitor &amp; grant intelligence
            </h2>

            <p id="competitor-analysis-modal-desc" className={bodyClass}>
              Find companies that won federal funding in your space, see how they described themselves
              to win, and get tailored, cited recommendations for what to emphasize. Every company and
              dollar amount comes from public federal award records (USAspending, NIH RePORTER, NSF) —
              nothing is invented, and each one links back to its official source so you can verify it.
            </p>

            {liveAvailable ? (
              <p className={bodyClass}>
                Run a <strong>live, personalized</strong> market brief for your company now — or preview a
                saved example first. The live run is real analysis, grounded in public award data; it is not
                a guarantee of funding.
              </p>
            ) : (
              <p className={bodyClass}>
                Here is a saved example built from {recordCount} real public award records — clearly labeled
                as an example, not a live run.
              </p>
            )}

            <div className="mt-6 flex flex-wrap items-center gap-3">
              {liveAvailable ? (
                <>
                  <button type="button" onClick={runLive} className={primaryBtnClass}>
                    Run live analysis
                  </button>
                  <button type="button" onClick={showDemo} className={secondaryBtnClass}>
                    Preview example
                  </button>
                </>
              ) : (
                <button type="button" onClick={showDemo} className={primaryBtnClass}>
                  View example analysis
                </button>
              )}
              <button type="button" onClick={onClose} className={textBtnClass}>
                Close
              </button>
            </div>

            <p className={footnoteClass}>
              The saved example uses real, public award data captured once. A live run retrieves fresh
              public records and analyzes them; it submits nothing and is analysis, not a guarantee of funding.
            </p>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}

function Spinner() {
  return (
    <svg
      className="h-6 w-6 animate-spin text-structure-on-canvas"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
      <path className="opacity-90" d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
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
