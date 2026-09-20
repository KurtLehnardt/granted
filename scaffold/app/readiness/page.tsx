"use client";

import { useMemo, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import {
  scoreReadiness,
  type DimensionResult,
  type DimensionStatus,
  type ReadinessAnswers,
  type ReadinessResult,
  type VerdictLevel,
} from "@/lib/readiness/score";

/**
 * GTM free lead-gen tool — the "Grant Readiness Score" (strategy.md §"Free tool").
 *
 * Zero friction: no signup, no API/LLM call, no login. A short form across the
 * dimensions the app actually screens on (reusing the real SAM/UEI/eligibility
 * requirements from components/ApplicationChecklist.tsx) computes a deterministic
 * 0–100 readiness grade CLIENT-SIDE via lib/readiness/score.ts, then shows the
 * grade, a per-dimension breakdown, the single highest-leverage fix, and an
 * honest verdict banner in the app's plain, non-sycophantic voice.
 *
 * HONEST + ON-BRAND: this scores readiness *to apply*, never eligibility for a
 * specific program and never odds of winning — see the persistent disclaimer.
 *
 * Email capture comes AFTER the grade (POST to the stubbed /api/readiness-lead),
 * and the primary CTA drops the user into the full matcher at `/`.
 *
 * Self-contained: styling uses only CON-02 design tokens (no raw hex — see
 * scripts/design/check-hex.mjs), it's dark-aware and mobile-responsive, and it
 * doesn't touch or import any existing route.
 */

// ---------------------------------------------------------------------------
// Form configuration — UI copy for the ~7 questions. The scoring weights and
// domain logic live in lib/readiness/score.ts; this is presentation only.
// ---------------------------------------------------------------------------

type Draft = Partial<ReadinessAnswers>;

type Option = { value: string; label: string };
type Question = {
  key: keyof ReadinessAnswers;
  legend: string;
  help: string;
  kind: "radio" | "select";
  options: Option[];
};

const QUESTIONS: Question[] = [
  {
    key: "entityFormed",
    legend: "Is your organization a legally formed entity?",
    help: "An LLC, C-corp, nonprofit, or similar — not just an idea or a single individual. Federal awards go to organizations.",
    kind: "radio",
    options: [
      { value: "yes", label: "Yes, it's formed" },
      { value: "no", label: "Not yet" },
    ],
  },
  {
    key: "usSmallBusiness",
    legend: "Are you a US-based small business?",
    help: "US-based, for-profit, and typically under 500 employees — the core eligibility for most federal small-business funding.",
    kind: "radio",
    options: [
      { value: "yes", label: "Yes" },
      { value: "no", label: "No / not sure it qualifies" },
    ],
  },
  {
    key: "samStatus",
    legend: "What's your SAM.gov registration status?",
    help: "SAM.gov is the federal vendor registry. Only “Active” status lets you apply or be paid — a new registration can take up to ~2 weeks to finish.",
    kind: "radio",
    options: [
      { value: "active", label: "Active" },
      { value: "in_progress", label: "Started, not Active yet" },
      { value: "not_started", label: "Not started" },
    ],
  },
  {
    key: "hasUei",
    legend: "Do you have a UEI (Unique Entity Identifier)?",
    help: "Your 12-character federal ID, assigned when you begin a SAM.gov registration.",
    kind: "radio",
    options: [
      { value: "yes", label: "Yes" },
      { value: "no", label: "No / not sure" },
    ],
  },
  {
    key: "rdComponent",
    legend: "Does your work have a genuine R&D or technical-innovation component?",
    help: "A real technical risk or unknown you're resolving — the gate for the SBIR/STTR R&D programs.",
    kind: "radio",
    options: [
      { value: "yes", label: "Yes, clearly" },
      { value: "somewhat", label: "Somewhat" },
      { value: "no", label: "No" },
    ],
  },
  {
    key: "commercialization",
    legend: "Do you have a path to commercialize it?",
    help: "A credible route to a product, customer, or market beyond the research itself.",
    kind: "radio",
    options: [
      { value: "yes", label: "Yes" },
      { value: "somewhat", label: "Roughly" },
      { value: "no", label: "Not yet" },
    ],
  },
  {
    key: "fundingTarget",
    legend: "How much funding are you targeting?",
    help: "Helps match you to programs whose award ranges actually fit — it isn't a pass/fail gate.",
    kind: "select",
    options: [
      { value: "under_50k", label: "Under $50K" },
      { value: "50k_250k", label: "$50K – $250K" },
      { value: "250k_1m", label: "$250K – $1M" },
      { value: "over_1m", label: "$1M+" },
      { value: "unsure", label: "Not sure yet" },
    ],
  },
];

// ---------------------------------------------------------------------------
// Shared token-class helpers (no raw hex — all CON-02 tokens).
// ---------------------------------------------------------------------------

const EYEBROW = "font-mono text-[11px] uppercase tracking-eyebrow text-structure-on-canvas";

/** Semantic fill + AA-safe ink per status, used only as filled chips/banners. */
const STATUS_CHIP: Record<DimensionStatus, string> = {
  ready: "bg-success text-on-semantic",
  in_progress: "bg-warning text-on-semantic",
  blocker: "bg-error text-token-white",
};

const STATUS_GLYPH: Record<DimensionStatus, string> = {
  ready: "✓",
  in_progress: "⚠",
  blocker: "✗",
};

const STATUS_WORD: Record<DimensionStatus, string> = {
  ready: "Ready",
  in_progress: "In progress",
  blocker: "Blocker",
};

const VERDICT_BANNER: Record<VerdictLevel, string> = {
  ready: "bg-success text-on-semantic",
  in_progress: "bg-warning text-on-semantic",
  blocked: "bg-error text-token-white",
};

/** The ring stroke color is decorative (non-text) — driven via currentColor. */
const RING_COLOR: Record<VerdictLevel, string> = {
  ready: "text-success",
  in_progress: "text-warning",
  blocked: "text-error",
};

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function ReadinessPage() {
  const [draft, setDraft] = useState<Draft>({});
  const [result, setResult] = useState<ReadinessResult | null>(null);
  const [showIncomplete, setShowIncomplete] = useState(false);
  const resultRef = useRef<HTMLDivElement | null>(null);

  const complete = useMemo(() => QUESTIONS.every((q) => draft[q.key] != null), [draft]);

  function setAnswer<K extends keyof ReadinessAnswers>(key: K, value: ReadinessAnswers[K]) {
    setDraft((d) => ({ ...d, [key]: value }));
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!complete) {
      setShowIncomplete(true);
      return;
    }
    setResult(scoreReadiness(draft as ReadinessAnswers));
    // Move focus/scroll to the result on the next paint.
    requestAnimationFrame(() => resultRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
  }

  function editAnswers() {
    setResult(null);
    setShowIncomplete(false);
  }

  return (
    <main className="mx-auto min-h-screen max-w-2xl bg-canvas px-6 py-14 text-foreground sm:py-20">
      <header className="mb-10">
        <Link href="/" className={`${EYEBROW} underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-structure-on-canvas focus-visible:ring-offset-2`}>
          Granted
        </Link>
        <h1 className="mt-4 text-balance font-display text-[34px] font-bold leading-[1.1] text-structure-on-canvas sm:text-[44px]">
          Grant Readiness Score
        </h1>
        <p className="mt-4 max-w-xl text-pretty font-body text-[16px] leading-relaxed text-foreground">
          Seven quick questions. An instant, honest read on whether you're ready to apply for federal
          funding — before you spend weeks on an application that gets rejected at the door. No signup,
          no waiting.
        </p>
      </header>

      {result ? (
        <div ref={resultRef}>
          <ResultView result={result} onEdit={editAnswers} />
        </div>
      ) : (
        <form onSubmit={onSubmit} noValidate className="stagger">
          <ol className="space-y-8">
            {QUESTIONS.map((q, i) => (
              <li key={q.key}>
                <QuestionField
                  q={q}
                  index={i + 1}
                  value={draft[q.key]}
                  missing={showIncomplete && draft[q.key] == null}
                  onChange={(v) => setAnswer(q.key, v as ReadinessAnswers[typeof q.key])}
                />
              </li>
            ))}
          </ol>

          {showIncomplete && !complete && (
            <p role="alert" className="mt-6 font-body text-[13px] leading-relaxed text-foreground">
              Answer all seven questions above to see your score — every one maps to a real federal
              requirement.
            </p>
          )}

          <button
            type="submit"
            className="mt-8 inline-flex min-h-[44px] w-full items-center justify-center rounded-md bg-action px-6 py-3 font-mono text-[13px] uppercase tracking-eyebrow text-token-white transition active:scale-[0.99] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-action focus-visible:ring-offset-2 sm:w-auto"
          >
            See my readiness score
          </button>

          <p className="mt-4 font-body text-[12px] italic leading-relaxed text-foreground">
            This measures your readiness to apply — not your eligibility for any specific program, and
            not your odds of winning. It runs entirely in your browser.
          </p>
        </form>
      )}
    </main>
  );
}

// ---------------------------------------------------------------------------
// Form field
// ---------------------------------------------------------------------------

function QuestionField({
  q,
  index,
  value,
  missing,
  onChange,
}: {
  q: Question;
  index: number;
  value: string | undefined;
  missing: boolean;
  onChange: (v: string) => void;
}) {
  const legendId = `q-${q.key}-legend`;
  const helpId = `q-${q.key}-help`;

  return (
    <fieldset aria-describedby={helpId} className="min-w-0">
      <legend id={legendId} className="font-display text-[17px] font-medium leading-snug text-foreground">
        <span className={`${EYEBROW} mr-2`}>{index}</span>
        {q.legend}
      </legend>
      <p id={helpId} className="mt-1.5 text-pretty font-body text-[13px] leading-relaxed text-foreground">
        {q.help}
      </p>

      {q.kind === "radio" ? (
        <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:flex-wrap" role="radiogroup" aria-labelledby={legendId}>
          {q.options.map((opt) => {
            const selected = value === opt.value;
            return (
              <label
                key={opt.value}
                className={[
                  "inline-flex min-h-[44px] cursor-pointer items-center gap-2 rounded-md border px-4 py-2.5 font-body text-[14px] transition",
                  "focus-within:outline-none focus-within:ring-2 focus-within:ring-structure-on-canvas focus-within:ring-offset-2",
                  selected
                    ? "border-structure-on-canvas bg-structure text-token-white"
                    : "border-structure-on-canvas bg-canvas-alt text-foreground hover:bg-structure hover:text-token-white",
                ].join(" ")}
              >
                <input
                  type="radio"
                  name={q.key}
                  value={opt.value}
                  checked={selected}
                  onChange={() => onChange(opt.value)}
                  className="sr-only"
                />
                <span aria-hidden className="font-mono text-[13px]">{selected ? "●" : "○"}</span>
                {opt.label}
              </label>
            );
          })}
        </div>
      ) : (
        <select
          name={q.key}
          value={value ?? ""}
          onChange={(e) => onChange(e.target.value)}
          aria-labelledby={legendId}
          className="mt-3 min-h-[44px] w-full rounded-md border border-structure-on-canvas bg-canvas-alt px-4 py-2.5 font-body text-[14px] text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-structure-on-canvas focus-visible:ring-offset-2 sm:w-auto"
        >
          <option value="" disabled>
            Select a range…
          </option>
          {q.options.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      )}

      {missing && (
        <p className="mt-2 font-body text-[12px] leading-relaxed text-foreground">
          <span aria-hidden>⚠ </span>Please answer this one.
        </p>
      )}
    </fieldset>
  );
}

// ---------------------------------------------------------------------------
// Result view
// ---------------------------------------------------------------------------

function ResultView({ result, onEdit }: { result: ReadinessResult; onEdit: () => void }) {
  const { grade, verdict, dimensions, topFix } = result;

  return (
    <div className="reveal space-y-8">
      {/* Honest verdict banner — filled, in the app's plain voice. */}
      <section className={`rounded-lg px-5 py-4 ${VERDICT_BANNER[verdict.level]}`} aria-label="Verdict">
        <p className="font-display text-[18px] font-bold leading-snug">{verdict.headline}</p>
        <p className="mt-1.5 text-pretty font-body text-[14px] leading-relaxed">{verdict.detail}</p>
      </section>

      {/* Grade + dial. */}
      <section className="flex flex-col items-center gap-5 rounded-lg bg-canvas-alt px-5 py-7 text-center shadow-card sm:flex-row sm:items-center sm:gap-7 sm:text-left">
        <GradeDial grade={grade} level={verdict.level} />
        <div className="min-w-0">
          <p className={EYEBROW}>Grant Readiness Score</p>
          <p className="mt-1 font-display text-[15px] leading-relaxed text-foreground">
            {grade}/100 — a measure of how ready you are to <em>apply</em>, weighted heaviest on the hard
            federal gates that cause outright rejections.
          </p>
          <p className="mt-2 font-body text-[12px] italic leading-relaxed text-foreground">
            Not an eligibility determination for any program, and not your odds of winning.
          </p>
        </div>
      </section>

      {/* Highest-leverage fix. */}
      {topFix && (
        <section className="rounded-lg border-l-2 border-structure-on-canvas bg-canvas-alt px-5 py-4">
          <p className={`${EYEBROW} mb-1.5`}>Your highest-leverage fix</p>
          <p className="font-display text-[15px] font-semibold leading-snug text-foreground">{topFix.label}</p>
          <p className="mt-1 text-pretty font-body text-[14px] leading-relaxed text-foreground">{topFix.action}</p>
        </section>
      )}

      {/* Per-dimension breakdown. */}
      <section aria-label="Readiness breakdown">
        <p className={`${EYEBROW} mb-3`}>The breakdown</p>
        <ul className="space-y-2.5">
          {dimensions.map((d) => (
            <BreakdownRow key={d.key} d={d} />
          ))}
        </ul>
      </section>

      {/* Email capture — AFTER the grade. */}
      <EmailCapture grade={grade} />

      {/* Primary CTA into the full matcher + share + edit. */}
      <section className="space-y-3">
        <Link
          href="/"
          className="inline-flex min-h-[44px] w-full items-center justify-center rounded-md bg-action px-6 py-3 font-mono text-[13px] uppercase tracking-eyebrow text-token-white transition active:scale-[0.99] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-action focus-visible:ring-offset-2"
        >
          Find the programs that actually fit →
        </Link>
        <div className="flex flex-col gap-3 sm:flex-row">
          <ShareButton grade={grade} verdictHeadline={verdict.headline} />
          <button
            type="button"
            onClick={onEdit}
            className="inline-flex min-h-[44px] w-full items-center justify-center gap-2 rounded-md border border-structure-on-canvas bg-canvas px-5 py-2.5 font-mono text-[12px] uppercase tracking-eyebrow text-structure-on-canvas transition hover:bg-structure hover:text-token-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-structure-on-canvas focus-visible:ring-offset-2 sm:w-auto"
          >
            Edit my answers
          </button>
        </div>
      </section>
    </div>
  );
}

function GradeDial({ grade, level }: { grade: number; level: VerdictLevel }) {
  const r = 52;
  const c = 2 * Math.PI * r;
  const filled = Math.max(0, Math.min(100, grade)) / 100;
  return (
    <div className="relative shrink-0" style={{ width: 128, height: 128 }}>
      <svg viewBox="0 0 128 128" width={128} height={128} aria-hidden className="-rotate-90">
        <circle cx={64} cy={64} r={r} fill="none" strokeWidth={10} className="text-canvas stroke-current" />
        <circle
          cx={64}
          cy={64}
          r={r}
          fill="none"
          strokeWidth={10}
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - filled)}
          className={`${RING_COLOR[level]} stroke-current`}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="font-display text-[32px] font-bold leading-none tabular-nums text-foreground">{grade}</span>
        <span className={`${EYEBROW} mt-0.5`}>/ 100</span>
      </div>
    </div>
  );
}

function BreakdownRow({ d }: { d: DimensionResult }) {
  return (
    <li className="flex items-start gap-3 rounded-md bg-canvas-alt px-4 py-3">
      <span
        className={`inline-flex shrink-0 items-center gap-1 rounded-sm px-2 py-0.5 font-mono text-[11px] uppercase tracking-eyebrow ${STATUS_CHIP[d.status]}`}
      >
        <span aria-hidden>{STATUS_GLYPH[d.status]}</span>
        {STATUS_WORD[d.status]}
      </span>
      <div className="min-w-0">
        <p className="font-display text-[14px] font-medium leading-snug text-foreground">
          {d.label}
          {d.hardGate && (
            <span className={`${EYEBROW} ml-2`} title="A rejection-causing federal gate">
              hard gate
            </span>
          )}
        </p>
        <p className="mt-0.5 text-pretty font-body text-[13px] leading-relaxed text-foreground">{d.detail}</p>
      </div>
    </li>
  );
}

// ---------------------------------------------------------------------------
// Email capture (stubbed backend)
// ---------------------------------------------------------------------------

function EmailCapture({ grade }: { grade: number }) {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<"idle" | "submitting" | "done" | "error">("idle");
  const [message, setMessage] = useState("");

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (status === "submitting") return;
    setStatus("submitting");
    setMessage("");
    try {
      const res = await fetch("/api/readiness-lead", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, grade }),
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (res.ok && data.ok) {
        setStatus("done");
      } else {
        setStatus("error");
        setMessage(data.error || "Something went wrong — please try again.");
      }
    } catch {
      setStatus("error");
      setMessage("Couldn't reach the server — please try again.");
    }
  }

  if (status === "done") {
    return (
      <section className="rounded-lg bg-structure px-5 py-5 text-token-white" aria-live="polite">
        <p className="font-display text-[16px] font-bold leading-snug">You're on the list.</p>
        <p className="mt-1.5 text-pretty font-body text-[14px] leading-relaxed">
          We'll send your full opportunity map. In the meantime, jump straight into the matcher below.
        </p>
      </section>
    );
  }

  return (
    <section className="rounded-lg bg-structure px-5 py-5 text-token-white">
      <p className="font-display text-[16px] font-bold leading-snug">Get your full opportunity map →</p>
      <p className="mt-1.5 text-pretty font-body text-[14px] leading-relaxed">
        Drop your email and we'll send a personalized map of the federal programs worth your time —
        grounded in real award data, honest about the ones that aren't.
      </p>
      <form onSubmit={onSubmit} noValidate className="mt-4 flex flex-col gap-3 sm:flex-row">
        <label htmlFor="readiness-email" className="sr-only">
          Email address
        </label>
        <input
          id="readiness-email"
          type="email"
          inputMode="email"
          autoComplete="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@company.com"
          className="min-h-[44px] w-full rounded-md border border-token-white bg-canvas px-4 py-2.5 font-body text-[14px] text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-token-white focus-visible:ring-offset-2 focus-visible:ring-offset-structure sm:flex-1"
        />
        <button
          type="submit"
          disabled={status === "submitting"}
          className="inline-flex min-h-[44px] items-center justify-center rounded-md bg-action px-6 py-2.5 font-mono text-[12px] uppercase tracking-eyebrow text-token-white transition active:scale-[0.99] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-token-white focus-visible:ring-offset-2 focus-visible:ring-offset-structure disabled:opacity-70"
        >
          {status === "submitting" ? "Sending…" : "Send it"}
        </button>
      </form>
      {status === "error" && (
        <p role="alert" className="mt-2 font-body text-[13px] leading-relaxed text-token-white">
          {message}
        </p>
      )}
      <p className="mt-2 font-body text-[11px] leading-relaxed text-token-white">
        No spam. We'll only use this to send your map.
      </p>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Share (the viral vector)
// ---------------------------------------------------------------------------

function ShareButton({ grade, verdictHeadline }: { grade: number; verdictHeadline: string }) {
  const [copied, setCopied] = useState(false);

  async function onShare() {
    const url = typeof window !== "undefined" ? window.location.href : "";
    const summary = `My Grant Readiness Score is ${grade}/100. ${verdictHeadline} Check yours free: ${url}`.trim();
    try {
      const nav = typeof navigator !== "undefined" ? navigator : undefined;
      if (nav && typeof nav.share === "function") {
        await nav.share({ title: "My Grant Readiness Score", text: summary, url });
        return;
      }
      if (nav && nav.clipboard && typeof nav.clipboard.writeText === "function") {
        await nav.clipboard.writeText(summary);
        setCopied(true);
        setTimeout(() => setCopied(false), 2200);
      }
    } catch {
      // A cancelled share or a denied clipboard is not an error worth surfacing.
    }
  }

  return (
    <button
      type="button"
      onClick={onShare}
      aria-live="polite"
      className="inline-flex min-h-[44px] w-full items-center justify-center gap-2 rounded-md border border-structure-on-canvas bg-canvas px-5 py-2.5 font-mono text-[12px] uppercase tracking-eyebrow text-structure-on-canvas transition hover:bg-structure hover:text-token-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-structure-on-canvas focus-visible:ring-offset-2 sm:w-auto"
    >
      {copied ? "Copied to clipboard ✓" : "Share my score"}
    </button>
  );
}
