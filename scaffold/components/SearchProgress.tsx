"use client";
import { useEffect, useRef, useState } from "react";
import type { LlmInfo } from "@/lib/llm/types";

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

/** Precise "Search took Xm Ys" for the post-result duration line. Unlike
 *  formatDuration, this is exact/legible, not a rounded hedge — it's shown
 *  once the real elapsed time is known. */
export function formatSearchDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m === 0 ? `${s}s` : `${m}m ${s}s`;
}

/**
 * Placeholder rough-range table for a local model's total run time, keyed by
 * parameter count — tune these once real hardware timing data exists. Ranges
 * grow with size since a bigger local model is straightforwardly slower.
 */
const LOCAL_ESTIMATE_RANGES: Array<{ maxB: number; range: string }> = [
  { maxB: 4, range: "10–20 minutes" },
  { maxB: 9, range: "12–25 minutes" },
  { maxB: 16, range: "15–30 minutes" },
];
const LOCAL_ESTIMATE_LARGE = "20–40 minutes or more";
const LOCAL_ESTIMATE_UNKNOWN = "several minutes or more";

/** The rough pre-search time range for a local model, by its parameter count
 *  (billions). Unknown/missing size -> the most hedged range. */
export function localModelEstimateRange(paramsB?: number): string {
  if (paramsB == null || !Number.isFinite(paramsB)) return LOCAL_ESTIMATE_UNKNOWN;
  const hit = LOCAL_ESTIMATE_RANGES.find((r) => paramsB <= r.maxB);
  return hit ? hit.range : LOCAL_ESTIMATE_LARGE;
}

/** "gemma3:12b (12B)" / "gemma3:12b" (size unknown) / "a local model" (name unknown). */
export function localModelLabel(model?: string, paramsB?: number): string {
  if (!model) return "a local model";
  const size = paramsB != null && Number.isFinite(paramsB) ? ` (${paramsB}B)` : "";
  return `${model}${size}`;
}

/** Extrapolate remaining scoring time (ms) from the observed rate so far —
 *  `done` of `total` items scored over `elapsedMs`. Null once there isn't
 *  enough signal yet (nothing scored, nothing left, or no elapsed time). */
export function estimateRemainingMs(done: number, total: number, elapsedMs: number): number | null {
  if (!(done > 0) || !(total > 0) || !(elapsedMs > 0) || done >= total) return null;
  const msPerItem = elapsedMs / done;
  return Math.round((total - done) * msPerItem);
}

/** "About 4 minutes left" / "About a minute left" / "About 20 seconds left". */
export function formatRemaining(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000));
  if (s < 60) return `About ${s} seconds left`;
  const m = Math.round(s / 60);
  return m <= 1 ? "About a minute left" : `About ${m} minutes left`;
}

/** Parses the "score-progress" step's `detail: "done/total"` field. */
export function parseScoreDetail(detail: string | undefined): { done: number; total: number } | null {
  if (!detail) return null;
  const m = /^(\d+)\/(\d+)$/.exec(detail.trim());
  if (!m) return null;
  return { done: Number(m[1]), total: Number(m[2]) };
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
  /** The current step's `key` (e.g. "start", "score-progress") — drives the
   *  live remaining-time estimate once scoring is underway. */
  realKey?: string;
  /** The current step's `detail` field, "done/total" on "score-progress". */
  realDetail?: string;
  /** Backend info from /api/match's "start" progress event. Undefined until
   *  that event arrives. */
  llm?: LlmInfo;
}) {
  const [display, setDisplay] = useState(4);
  const [elapsed, setElapsed] = useState(0);
  const [factIndex, setFactIndex] = useState(0);
  const floorRef = useRef(0);
  // Wall-clock time of the FIRST score-progress event, so the live estimate
  // extrapolates from the observed scoring rate, not from the whole search's
  // elapsed time (which includes intake/embedding/retrieval before scoring
  // even starts).
  const scoreStartRef = useRef<number | null>(null);
  const [liveRemaining, setLiveRemaining] = useState<string | null>(null);
  // The duration of this browser's LAST successful search (ms), written by
  // IntakeForm on completion. It's the only honest per-machine predictor: hosted
  // and local runs differ by an order of magnitude, and this component can't read
  // the server-side provider. Null on the first-ever run (or if storage is blocked).
  const [lastMs, setLastMs] = useState<number | null>(null);
  useEffect(() => {
    try {
      const n = Number(window.localStorage.getItem("granted:lastSearchMs"));
      if (Number.isFinite(n) && n > 0) setLastMs(n);
    } catch { /* localStorage unavailable — fall back to the generic line */ }
  }, []);

  // Live remaining-time estimate: extrapolate from the observed scoring rate
  // once "score-progress" events (done/total) start arriving.
  useEffect(() => {
    if (realKey !== "score-progress") return;
    const parsed = parseScoreDetail(realDetail);
    if (!parsed) return;
    if (scoreStartRef.current == null) scoreStartRef.current = Date.now();
    const elapsedMs = Date.now() - scoreStartRef.current;
    const remainingMs = estimateRemainingMs(parsed.done, parsed.total, elapsedMs);
    setLiveRemaining(remainingMs == null ? null : formatRemaining(remainingMs));
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
  // Backend-aware status line: hosted never mentions local models; local names
  // the model + a rough range, then swaps that range for a live estimate once
  // scoring progress arrives. `estimate` (above) takes priority when known.
  const statusMessage = !llm || !llm.local
    ? "This scores your fit across the opportunities. Hosted models take about a minute or two."
    : liveRemaining
      ? `Running ${localModelLabel(llm.model, llm.paramsB)} locally. ${liveRemaining}.`
      : `Running ${localModelLabel(llm.model, llm.paramsB)} locally — this can take ${localModelEstimateRange(llm.paramsB)}, depending on your hardware.`;
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
        {estimate
          ? `Your last search took ${estimate}, so this one should be similar. Hang tight.`
          : `${statusMessage} You can leave this tab open and check back — the search keeps running while it's open.`}
      </p>
    </div>
  );
}
