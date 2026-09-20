"use client";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import IntakeForm from "@/components/IntakeForm";
import OpportunityMap from "@/components/OpportunityMap";
import type { OpportunityMap as MapT } from "@/lib/types";
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

      <IntakeForm onResult={setMap} />

      {map && (
        <div className="mt-14">
          <OpportunityMap map={map} />
        </div>
      )}
    </main>
  );
}
