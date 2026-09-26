"use client";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import IntakeForm from "@/components/IntakeForm";
import OpportunityMap, { CARD_CAP, Boundary } from "@/components/OpportunityMap";
import OpportunityCard from "@/components/OpportunityCard";
import type { OpportunityMap as MapT, Match } from "@/lib/types";
import AppMenu from "@/components/AppMenu";
import { isFlagEnabled } from "@/lib/flags";
import { SidebarProvider, useSidebar } from "@/components/SidebarProvider";
import WelcomeTour from "@/components/WelcomeTour";
import { useAnalytics } from "@/components/AnalyticsProvider";
import { latestRun, saveRun } from "@/lib/runs/runsStore";

// FE-01 / design revamp: the CON-02 USWDS 60/30/10 restyle is now the DEFAULT
// look on this A/B branch (previously gated behind r7_design). The token
// classes are applied unconditionally here.
//
// FE-07: when `left_sidebar` is ON, the persistent, collapsible left sidebar
// (AppMenu → AppSidebar) sits BESIDE this content on desktop, so the column
// shifts right by the sidebar width (SidebarProvider + the `.app-content-shift`
// rule in globals.css). Flag OFF keeps the pre-sidebar layout untouched.
export default function Home() {
  const sidebarOn = isFlagEnabled("left_sidebar");
  if (!sidebarOn) return <HomeShell sidebarOn={false} />;
  return (
    <SidebarProvider>
      <HomeShell sidebarOn />
    </SidebarProvider>
  );
}

function HomeShell({ sidebarOn }: { sidebarOn: boolean }) {
  const [map, setMap] = useState<MapT | null>(null);
  // Outside the provider (flag OFF) this is an inert no-op fallback, so calling
  // it unconditionally is safe and the flag-OFF render stays byte-identical.
  const { expanded, width, resizing } = useSidebar();
  const analytics = useAnalytics();

  // Progressive results: while a search is running, cards stream in one match
  // at a time (IntakeForm's onMatchPreview, fed by the server's per-batch
  // "match" events) instead of the user staring at a bare progress bar until
  // the whole candidate set finishes scoring. `loading` mirrors IntakeForm's
  // own state (via onLoadingChange) so this component knows when to show the
  // growing preview list + "finding more" spinner instead of the last
  // completed `map` — and when to hand back off to it.
  const [loading, setLoading] = useState(false);
  const [previewMatches, setPreviewMatches] = useState<Match[]>([]);

  function handleLoadingChange(isLoading: boolean) {
    setLoading(isLoading);
    // Reset at the START of every run (not the end): on success `map` is about
    // to be replaced by the complete, authoritative result anyway; on failure
    // IntakeForm's own error UI takes over and any partial preview from the
    // failed attempt is stale, not a real result — either way it must not
    // linger into the NEXT run.
    if (isLoading) setPreviewMatches([]);
  }

  function handleMatchPreview(m: Match) {
    setPreviewMatches((prev) => {
      // A "none"-tier match would never make the finished map's card list
      // either (OpportunityMap filters the same way) — skip it here so the
      // preview never shows a card that's about to vanish once scoring
      // finishes. Capped at the same CARD_CAP the finished map settles on, so
      // the visible card count never visibly SHRINKS when the real map
      // replaces this preview.
      if (m.tier === "none" || prev.length >= CARD_CAP) return prev;
      return [...prev, m];
    });
  }

  // Arch review MEDIUM: persist completed runs so a reload doesn't lose the
  // ~2-minute result. Restore the most recent run once on mount if the user
  // hasn't already started a new search. `restoredRef` marks that the current
  // map came from a restore, so the funnel effect below doesn't re-emit
  // first_result_rendered for it (a reload isn't a fresh search).
  const restoredRef = useRef(false);
  useEffect(() => {
    if (map) return;
    const last = latestRun();
    if (last) {
      restoredRef.current = true;
      setMap(last.map);
    }
    // Once, on mount only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Desktop content shift: pad left by the sidebar width when expanded. The
  // padding only applies >= md (globals.css); during a resize drag we drop the
  // transition so the column tracks the pointer instead of lagging behind it.
  const shiftStyle: CSSProperties | undefined = sidebarOn
    ? ({ ["--app-sidebar-offset"]: `${expanded ? width : 0}px` } as CSSProperties)
    : undefined;
  const mainClass = [
    "mx-auto min-h-screen max-w-4xl bg-canvas px-6 py-14 text-foreground sm:py-20",
    sidebarOn ? "app-content-shift" : "",
    sidebarOn && resizing ? "app-content-shift--instant" : "",
  ]
    .filter(Boolean)
    .join(" ");

  // H5 (R10.1) — funnel emit at the real "result shown" call site: when a map
  // renders. A normal result fires `first_result_rendered`; the honest-no
  // finding (weak field) fires `run_completed` with `honest_no`. Both are
  // counts/flags only (no description content), and no-op unless r10_analytics
  // is on. Keyed on the map object (a fresh one per search) so it fires once.
  useEffect(() => {
    if (!map) return;
    // A restored run (reload) is not a fresh search — persist nothing new and
    // don't re-emit the result funnel; just clear the flag for the next change.
    if (restoredRef.current) {
      restoredRef.current = false;
      return;
    }
    // Fresh completed result: persist it so a subsequent reload can restore it.
    saveRun(map);
    const resultsShown = map.matches.length;
    if (resultsShown > 0) {
      analytics.firstResultRendered({
        results_shown: resultsShown,
        high_potential: map.summary.highPotential,
      });
    }
    if (map.weakFieldFinding) {
      analytics.runCompleted({ honest_no: true, high_potential: map.summary.highPotential });
    } else if (resultsShown === 0) {
      analytics.runCompleted({ results_shown: 0 });
    }
    // analytics identity is stable (useMemo in the provider); map drives this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map]);

  return (
    <main className={mainClass} style={shiftStyle}>
      {/* Anchored, non-blocking welcome guide on first load (flag-ON only):
          spotlights Sign in → sample companies → the description box. */}
      {sidebarOn && <WelcomeTour />}

      {/*
        FE-06: single nav cluster — hamburger (Settings, always present) +
        the PLT-01 mock-auth surface (UserMenu / "Sign in", flag-gated,
        unchanged behavior) now both live inside AppMenu instead of being
        split across an inline block here. FE-07 ON: AppMenu instead renders
        the persistent sidebar (which carries its own toggles + identity).
      */}
      <div className="mb-6">
        <AppMenu />
      </div>

      {/* Split-and-stagger hero entrance (polish): eyebrow → headline → sub
          rise in sequence on first load. Reduced-motion disables it globally. */}
      <header className="stagger mb-12">
        {/* Hero banner (replaces the eyebrow): larger, centered above the headline.
            Navy-on-transparent → white in dark mode via the filter. */}
        <img
          src="/brand/logo-banner.png"
          alt="Granted"
          className="mx-auto h-20 w-auto select-none dark:brightness-0 dark:invert sm:h-24"
        />
        <h1 className="mt-4 max-w-2xl text-balance font-display text-[40px] font-bold leading-[1.08] text-structure-on-canvas sm:text-[52px]">
          Grant funds are waiting<br />Let's find your match
        </h1>
        <p className="mt-5 max-w-xl text-pretty font-body text-[16px] leading-relaxed text-foreground">
          Describe your company the way you'd describe it to a friend. We'll translate it
          into the language the federal government uses — and tell you plainly when there's
          nothing worth chasing.
        </p>
      </header>

      <IntakeForm
        onResult={setMap}
        onLoadingChange={handleLoadingChange}
        onMatchPreview={handleMatchPreview}
      />

      {/* While a search is running, show cards as they're scored instead of the
          last completed map (which is about to be replaced anyway — showing it
          alongside a growing, different set of incoming cards would just be
          confusing). The instant loading ends, this hands off to the finished,
          authoritative `map` below — on success that's the fresh result; on
          failure it's simply whatever `map` already held before this run. */}
      {loading ? (
        previewMatches.length > 0 && (
          <Boundary>
            <div className="mt-14">
              <p className="font-mono text-[11px] uppercase tracking-eyebrow text-structure-on-canvas">
                Your opportunity map
              </p>
              <div className="mt-4 space-y-3">
                {previewMatches.map((m, i) => (
                  <OpportunityCard key={m.opportunity?.id ?? i} m={m} index={i} />
                ))}
              </div>
              <div
                className="mt-4 flex items-center gap-2 font-mono text-[12px] text-foreground"
                role="status"
                aria-live="polite"
              >
                <PreviewSpinner />
                Finding more matching grants&hellip;
              </div>
            </div>
          </Boundary>
        )
      ) : (
        map && (
          <div className="mt-14">
            <OpportunityMap map={map} />
          </div>
        )
      )}
    </main>
  );
}

/** Small inline spinner for the progressive-results "finding more" status row
 *  (mirrors the loading-state spinner in CompetitorAnalysisModal.tsx). */
function PreviewSpinner() {
  return (
    <svg className="h-3.5 w-3.5 animate-spin text-structure-on-canvas" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
      <path className="opacity-90" d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}
