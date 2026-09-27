"use client";
import { useEffect, useRef, useState } from "react";
import type { LlmInfo } from "@/lib/llm/types";
import { LAST_SEARCH_MS_KEY } from "@/lib/searchSettings";

/**
 * SearchProgress — the loading experience while /api/match runs (novel input can
 * take ~2 minutes: embed → hybrid search → eligibility → explain).
 *
 * HYBRID progress: the backend streams REAL pipeline milestones (props `realPct`
 * / `realLabel`) — those are a monotonic FLOOR the bar snaps up to. Between
 * milestones a gentle time-based creep keeps the bar moving, capped just below
 * the next real milestone so a real step always reads as an upward jump, never a
 * backwards correction. Nothing here ever claims 100% — the parent unmounts this
 * the moment the real result arrives.
 *
 * The rotating facts are real, hedged figures about federal funding — not invented
 * numbers. Honest claims are the whole point of this product; keep them true.
 */

const FACTS: string[] = [
  "SBIR and STTR award more than $4 billion a year to small businesses — it's often called America's Seed Fund.",
  "SBIR/STTR funding is non-dilutive: no equity taken, nothing to repay. You keep your company and your IP.",
  "Eleven federal agencies run SBIR programs — from the NIH and NSF to the Department of Defense and NASA.",
  "Every agency with a large R&D budget must set aside a slice of it specifically for small businesses.",
  "A Phase I award is typically $50k–$300k to prove feasibility; Phase II can run past $1M to build it.",
  "grants.gov lists thousands of open opportunities across 26 federal grant-making agencies at any given time.",
  "The U.S. government is one of the largest funders of research and development in the world.",
  "Companies often qualify for more programs than they expect — that's exactly what this search is checking.",
];

const FACT_MIN_MS = 10_000; // rotate the "did you know" facts on a randomized
const FACT_MAX_MS = 15_000; // 10–15s dwell — slow enough to read, varied enough to stay engaging
const TICK_MS = 200;
const EASE_K = 0.008; // per-tick ease toward the phase cap (~90% of a gap in ~60s)

/** Soft ceiling for the time-creep given the last real milestone reached. Each
 *  cap sits BELOW the next real milestone (5→18→32→46→52→90) so the next real
 *  step is always a visible jump up, never a correction down. */
function softCap(floor: number): number {
  if (floor >= 90) return 98;
  if (floor >= 52) return 88; // the long scoring/explaining phase
  if (floor >= 46) return 50;
  if (floor >= 32) return 44;
  if (floor >= 18) return 30;
  if (floor >= 5) return 16;
  return 12;
}

/** Human, rounded duration for the "your last search took ~X" estimate. */
export function formatDuration(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000));
  if (s < 60) return `about ${s} seconds`;
  const m = Math.round(s / 60);
  return m <= 1 ? "about a minute" : `about ${m} minutes`;
}

/** Exact "7m 33s" for the post-result "Search took" line. */
export function formatSearchDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m === 0 ? `${s}s` : `${m}m ${s}s`;
}

// Measured on ~32-candidate searches (one scoring call each): 3B on a 4GB Quadro P1000
// took 16–31 min; 14B on a 32GB Mac ran ~37s/candidate.
const LOCAL_ESTIMATE_RANGES: Array<{ maxB: number; range: string }> = [
  { maxB: 4, range: "15–30 minutes" },
  { maxB: 9, range: "20–40 minutes" },
  { maxB: 16, range: "20–45 minutes" },
];

export function localModelEstimateRange(paramsB?: number): string {
  if (paramsB == null || !Number.isFinite(paramsB)) return "15 minutes or more";
  return LOCAL_ESTIMATE_RANGES.find((r) => paramsB <= r.maxB)?.range ?? "30–60 minutes or more";
}

export function localModelLabel(model?: string, paramsB?: number): string {
  if (!model) return "a local model";
  return paramsB != null && Number.isFinite(paramsB) ? `${model} (${paramsB}B)` : model;
}

/** Linear extrapolation from the observed scoring rate; null when there's nothing to extrapolate. */
export function estimateRemainingMs(done: number, total: number, elapsedMs: number): number | null {
  if (!(done > 0) || !(elapsedMs > 0) || done >= total) return null;
  return Math.round(((total - done) * elapsedMs) / done);
}

/** The "score-progress" step's `detail: "done/total"`. */
export function parseScoreDetail(detail: string | undefined): { done: number; total: number } | null {
  const m = /^(\d+)\/(\d+)$/.exec(detail?.trim() ?? "");
  return m ? { done: Number(m[1]), total: Number(m[2]) } : null;
}

export default function SearchProgress({
  realPct,
  realLabel,
  realKey,
  realDetail,
  llm,
}: {
  realPct?: number;
  realLabel?: string;
  realKey?: string;
  realDetail?: string;
  llm?: LlmInfo;
}) {
  const [display, setDisplay] = useState(4);
  const [elapsed, setElapsed] = useState(0);
  const [factIndex, setFactIndex] = useState(0);
  const floorRef = useRef(0);
  const scoreStartRef = useRef<number | null>(null);
  const [remainingMs, setRemainingMs] = useState<number | null>(null);
  // The duration of this browser's LAST successful search (ms), written by
  // IntakeForm on completion. It's the only honest per-machine predictor: hosted
  // and local runs differ by an order of magnitude, and this component can't read
  // the server-side provider. Null on the first-ever run (or if storage is blocked).
  const [lastMs, setLastMs] = useState<number | null>(null);
  useEffect(() => {
    try {
      const n = Number(window.localStorage.getItem(LAST_SEARCH_MS_KEY));
      if (Number.isFinite(n) && n > 0) setLastMs(n);
    } catch { /* localStorage unavailable — fall back to the generic line */ }
  }, []);

  // Time from the "score" step, not the first "score-progress" (which lands only after
  // the first call finishes). The final done==total reading keeps the last estimate.
  useEffect(() => {
    if (realKey === "score" && scoreStartRef.current == null) scoreStartRef.current = Date.now();
    if (realKey !== "score-progress") return;
    const parsed = parseScoreDetail(realDetail);
    if (!parsed) return;
    scoreStartRef.current ??= Date.now();
    const next = estimateRemainingMs(parsed.done, parsed.total, Date.now() - scoreStartRef.current);
    if (next != null) setRemainingMs(next);
  }, [realKey, realDetail]);

  // A real milestone raises the monotonic floor and snaps the bar up to include it.
  useEffect(() => {
    if (typeof realPct === "number" && realPct > floorRef.current) {
      floorRef.current = realPct;
      setDisplay((d) => Math.max(d, realPct));
    }
  }, [realPct]);

  // Time-creep toward the current phase cap; keeps motion between real steps.
  useEffect(() => {
    const started = Date.now();
    const id = window.setInterval(() => {
      setElapsed((Date.now() - started) / 1000);
      setDisplay((d) => {
        const cap = softCap(floorRef.current);
        if (d >= cap) return d; // hold at the cap until the next real step lands
        return Math.min(cap, d + (cap - d) * EASE_K);
      });
    }, TICK_MS);
    return () => window.clearInterval(id);
  }, []);

  // Rotate the "did you know" facts on a randomized 10–15s dwell — decoupled from
  // the progress ticker so it reads at a comfortable, non-jumpy pace.
  useEffect(() => {
    let cancelled = false;
    let timer: number;
    const schedule = () => {
      const delay = FACT_MIN_MS + Math.random() * (FACT_MAX_MS - FACT_MIN_MS);
      timer = window.setTimeout(() => {
        if (cancelled) return;
        setFactIndex((i) => (i + 1) % FACTS.length);
        schedule();
      }, delay);
    };
    schedule();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, []);

  const label = realLabel || "Reading the federal register…";
  const fact = FACTS[factIndex];
  const estimate = lastMs ? formatDuration(lastMs) : null;
  const localLive = llm?.local && remainingMs != null
    ? `Running ${localModelLabel(llm.model, llm.paramsB)} locally, ${formatDuration(remainingMs)} left.`
    : null;
  const statusMessage = localLive ?? (!llm
    ? "This scores your fit across the candidate programs."
    : !llm.local
      ? "This scores your fit across the candidate programs and usually takes a minute or two."
      : `Running ${localModelLabel(llm.model, llm.paramsB)} locally — this can take ${localModelEstimateRange(llm.paramsB)}, depending on your hardware.`);
  const mm = Math.floor(elapsed / 60);
  const ss = Math.floor(elapsed % 60).toString().padStart(2, "0");
  const pct = Math.round(display);

  // Polish: elevated card (fixes a broken /30 alpha border that CSS-var-backed
  // tokens can't compute), and the progress FILL is the spec-reserved `action`
  // green (R7.2: green = primary CTA + progress fill only). The fill animates
  // via an interruptible width transition — never a keyframe — so a real
  // milestone snaps up cleanly and never masks state.
  const cardClass = "mt-4 rounded-lg bg-canvas-alt px-4 py-4 shadow-card";
  const trackClass = "h-2.5 w-full overflow-hidden rounded-full bg-canvas";
  const fillClass = "h-full rounded-full bg-action transition-[width] duration-700 ease-out";
  const phaseClass = "font-mono text-[12px] text-structure-on-canvas";
  const mutedClass = "font-mono text-[12px] tabular-nums text-foreground";
  const factClass = "mt-3 text-pretty font-body text-[13px] leading-relaxed text-foreground";

  return (
    <div className={cardClass} role="status" aria-live="polite" aria-label={`Searching — ${label}`}>
      <div className="mb-2 flex items-center justify-between gap-3">
        <span className={phaseClass}>{label}</span>
        <span className={mutedClass} aria-hidden="true">
          {pct}% · {mm}:{ss}
        </span>
      </div>

      <div className={trackClass}>
        <div className={fillClass} style={{ width: `${pct}%` }} />
      </div>

      {/* key={fact} remounts on each rotation; `reveal` gives a gentle one-shot
          fade-in (low-frequency, reduced-motion-safe) as facts cycle. */}
      <p key={fact} className={`${factClass} reveal`}>
        <span className="font-mono text-[11px] uppercase tracking-eyebrow opacity-70">Did you know&nbsp;·&nbsp;</span>
        {fact}
      </p>

      <p className={`mt-3 text-pretty ${mutedClass}`}>
        {!localLive && estimate
          ? `Your last search took ${estimate}, so this one should be similar. Hang tight.`
          : `${statusMessage} You can leave this tab open and check back — the search keeps running while it's open.`}
      </p>
    </div>
  );
}
