/**
 * D3 — Funding Strategy.
 *
 * A DETERMINISTIC, PURE derivation over an existing `OpportunityMap`: it takes
 * the matches the pipeline already computed and produces an ordered 12-month
 * plan of UP TO 5 "programs to investigate," sequenced by
 *
 *   1. fit          — which programs make the cut (best fit first),
 *   2. real deadline — nearer real deadlines get earlier action slots,
 *   3. registration  — federal registration (SAM.gov / UEI / AOR) is weeks of
 *                      lead time, so a "start registration now" note is emitted
 *                      ahead of the first hard deadline.
 *
 * HONESTY INVARIANTS (do not weaken):
 *   - This is a research plan, NEVER a promise of funding or an award.
 *   - A deadline is shown ONLY when the program actually carries a real, future
 *     one. Evergreen / rolling / continuous / standing programs — and programs
 *     whose deadline is absent, unparseable, or already past — are slotted
 *     FLEXIBLY with `deadline: null`. We NEVER invent a deadline for them.
 *
 * No LLM, no network, no `Date.now()` baked into the logic path: the reference
 * time is an injectable `opts.now` (defaults to the current time only at the
 * call site), so the sequencing is fully reproducible in tests.
 *
 * Like `components/AgencyMap.tsx`'s `deriveAgencyRelevance`, the input is typed
 * as a dependency-light structural subset (`FundingStrategyMapLike`) so it is
 * hermetically testable, while the real `@/lib/types` `OpportunityMap`
 * (a structural superset) still flows in unchanged from the component.
 */

// ---------------------------------------------------------------------------
// Structural input shapes (a subset of the real OpportunityMap / Match)
// ---------------------------------------------------------------------------

/** A required-step as it rides on a match's eligibility determination. */
export type StrategyRequiredStepLike = {
  step?: string;
  lead_time_days?: number;
  why?: string;
};

/** Minimal opportunity shape the strategy reads. Subset of §3.4 Opportunity. */
export type StrategyOpportunityLike = {
  id?: string;
  program?: string;
  title?: string;
  agency?: string;
  kind?: string;
  status?: string;
  /** The program's OWN real deadline, if any. Never fabricated downstream. */
  deadline?: string;
  /** Free-text eligibility prose (v1 corpus). Scanned for a registration gate. */
  eligibility?: string;
  description?: string;
};

/** Minimal match shape the strategy reads. Subset of `@/lib/types` `Match`. */
export type StrategyMatchLike = {
  score?: number;
  tier?: string;
  opportunity?: StrategyOpportunityLike;
  /** ELG-04 determination attached by `buildOpportunityMap`, when present. */
  eligibility?: {
    determination?: {
      bucket?: string;
      required_steps?: StrategyRequiredStepLike[];
    };
  } | null;
};

/** Minimal map shape — a structural subset of the real `OpportunityMap`. */
export type FundingStrategyMapLike = {
  matches?: StrategyMatchLike[] | null;
};

// ---------------------------------------------------------------------------
// Output shapes
// ---------------------------------------------------------------------------

/** A suggested window to act, within the 12-month horizon. */
export type ActionWindow = {
  /** 1-based month index within the horizon (1 = the current month). */
  month: number;
  /** Quarter label derived from `month` (Q1 = months 1-3, …). */
  quarter: string;
  /** Human label, e.g. "Month 2 (Q1)" or "Flexible (rolling)". */
  label: string;
  /** True when the window is flexible (evergreen/rolling — no real deadline). */
  flexible: boolean;
};

export type FundingStrategyItem = {
  /** The program to investigate (passed through from the match). */
  opportunity: StrategyOpportunityLike;
  score: number;
  tier: string;
  /** The program's own REAL, future deadline (ISO). `null` for flexible ones. */
  deadline: string | null;
  /** True only when a real, future deadline drove the window. Never invented. */
  hasDeadline: boolean;
  /** Federal registration (SAM.gov / UEI / AOR) is a prerequisite here. */
  requiresRegistration: boolean;
  /** Registration lead time in days used for planning (when required). */
  registrationLeadDays: number;
  window: ActionWindow;
  /** Fit + deadline urgency + registration lead-time, in plain language. */
  rationale: string;
};

export type FundingStrategy = {
  /** Honest one-line framing: a plan to investigate, not a promise of award. */
  intro: string;
  /** Up to 5 programs, ordered chronologically across the 12-month horizon. */
  items: FundingStrategyItem[];
  /** "Start registration now" note, emitted when any selected program needs
   *  federal registration; `null` when none do. */
  registrationNote: string | null;
};

export type BuildFundingStrategyOptions = {
  /** Reference "now". Injected for deterministic tests; defaults to new Date(). */
  now?: Date;
  /** Planning horizon in months. Defaults to 12. */
  horizonMonths?: number;
  /** Max programs in the plan. Defaults to 5. */
  cap?: number;
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const FUNDING_STRATEGY_CAP = 5;
export const STRATEGY_HORIZON_MONTHS = 12;

/**
 * Typical SAM.gov + UEI registration lead time, in days. Mirrors
 * `SAM_REGISTRATION_LEAD_TIME_DAYS` in `lib/eligibility/screen.ts` (2 CFR
 * 25.200 says only "several weeks"; this is a conservative typical minimum for
 * a concrete planning number). Used only when a program's own determination
 * does not carry a more specific `lead_time_days`.
 */
export const DEFAULT_REGISTRATION_LEAD_DAYS = 21;

/** Buffer for actually assembling/writing the application, on top of registration. */
const APPLICATION_PREP_DAYS = 30;

const DAY_MS = 86_400_000;
const DAYS_PER_MONTH = 30.44;

const TIER_WEIGHT: Record<string, number> = { likely: 3, verify: 2, adjacent: 1, none: 0 };

/** Statuses that are inherently evergreen — never deadline-driven (§3.4). */
const EVERGREEN_STATUSES = new Set(["rolling", "continuous", "standing"]);

const MONTH_ABBR = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function programName(m: StrategyMatchLike): string {
  const o = m.opportunity;
  return (o?.title ?? o?.program ?? o?.agency ?? "").toString();
}

function quarterOf(month: number): string {
  return `Q${Math.ceil(month / 3)}`;
}

/** UTC, locale-independent date formatting so output is deterministic. */
function formatDate(ms: number): string {
  const d = new Date(ms);
  return `${MONTH_ABBR[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}

/**
 * The program's own REAL, future deadline in ms — or `null` when it has none we
 * may act on (evergreen status, missing / unparseable / already-past deadline).
 * We NEVER synthesize one here.
 */
function realFutureDeadlineMs(o: StrategyOpportunityLike | undefined, nowMs: number): number | null {
  if (!o) return null;
  const status = (o.status ?? "").toLowerCase();
  if (EVERGREEN_STATUSES.has(status)) return null;
  if (!isNonEmptyString(o.deadline)) return null;
  const t = Date.parse(o.deadline);
  if (Number.isNaN(t)) return null;
  if (t <= nowMs) return null; // a past deadline is not an actionable date
  return t;
}

const REGISTRATION_PROSE =
  /\b(sam\.gov|system for award management|unique entity id|\buei\b|\baor\b|authorized organization representative|register(?:ed|ing)? (?:in|with|on) (?:sam|grants\.gov))\b/i;

/**
 * Does this program imply federal registration (SAM.gov / UEI / AOR) as a
 * prerequisite? Grounded in real signals, in priority order:
 *   1. the ELG-01 determination attached to the match (a `required_step` or a
 *      `conditionally_eligible` bucket — screen() emits the SAM/UEI step), and
 *      its own `lead_time_days` if present;
 *   2. registration prose in the opportunity's eligibility / description text.
 * Returns the detection plus the lead time to plan against.
 */
function detectRegistration(m: StrategyMatchLike): { required: boolean; leadDays: number } {
  const det = m.eligibility?.determination;
  if (det) {
    const steps = Array.isArray(det.required_steps) ? det.required_steps : [];
    const stepLead = steps
      .map((s) => (typeof s?.lead_time_days === "number" ? s.lead_time_days : 0))
      .reduce((a, b) => Math.max(a, b), 0);
    if (steps.length > 0 || det.bucket === "conditionally_eligible") {
      return { required: true, leadDays: stepLead > 0 ? stepLead : DEFAULT_REGISTRATION_LEAD_DAYS };
    }
  }
  const o = m.opportunity;
  const prose = `${o?.eligibility ?? ""} ${o?.description ?? ""}`;
  if (REGISTRATION_PROSE.test(prose)) {
    return { required: true, leadDays: DEFAULT_REGISTRATION_LEAD_DAYS };
  }
  return { required: false, leadDays: 0 };
}

function tierPhrase(tier: string, score: number): string {
  const s = Math.round(score);
  switch (tier) {
    case "likely":
      return `Strong fit (score ${s})`;
    case "verify":
      return `Possible fit — verify eligibility (score ${s})`;
    case "adjacent":
      return `Adjacent opportunity (score ${s})`;
    default:
      return `Candidate (score ${s})`;
  }
}

// ---------------------------------------------------------------------------
// The build entry point
// ---------------------------------------------------------------------------

/**
 * Build the ordered 12-month funding strategy from an `OpportunityMap`.
 *
 * Selection (which programs, capped at 5) prioritizes FIT; the sequence (list
 * order + each program's action window) is driven by real deadlines, with
 * evergreen programs slotted flexibly. See the module header for invariants.
 */
export function buildFundingStrategy(
  map: FundingStrategyMapLike | null | undefined,
  opts: BuildFundingStrategyOptions = {},
): FundingStrategy {
  const now = opts.now ?? new Date();
  const nowMs = now.getTime();
  const horizon = opts.horizonMonths ?? STRATEGY_HORIZON_MONTHS;
  const cap = opts.cap ?? FUNDING_STRATEGY_CAP;

  const rawMatches = Array.isArray(map?.matches) ? map!.matches! : [];

  // Real fits only — never wall the user with "none"-tier rows. Dedupe by
  // opportunity id, keeping the best-fit instance.
  const byId = new Map<string, StrategyMatchLike>();
  const anon: StrategyMatchLike[] = [];
  for (const m of rawMatches) {
    if (!m || !m.opportunity) continue;
    if ((m.tier ?? "none") === "none") continue;
    const id = m.opportunity.id;
    if (isNonEmptyString(id)) {
      const prev = byId.get(id);
      if (!prev || compareFit(m, prev) < 0) byId.set(id, m);
    } else {
      anon.push(m);
    }
  }
  const candidates = [...Array.from(byId.values()), ...anon];

  // SELECT: best fit first (fit → nearer real deadline → name), capped.
  const selected = candidates
    .slice()
    .sort((a, b) => compareForSelection(a, b, nowMs))
    .slice(0, cap);

  // First pass: split into deadline-driven vs flexible, computing the action
  // month for each real-deadline program (nearer deadline → earlier month,
  // backing off the registration + prep lead time).
  type Prepared = {
    m: StrategyMatchLike;
    o: StrategyOpportunityLike;
    score: number;
    tier: string;
    reg: { required: boolean; leadDays: number };
    deadlineMs: number | null;
    month: number; // final only for deadline items after pass 1; filled for flexible in pass 2
    flexible: boolean;
  };

  const prepared: Prepared[] = selected.map((m) => {
    const o = m.opportunity!;
    const score = typeof m.score === "number" ? m.score : 0;
    const tier = m.tier ?? "";
    const reg = detectRegistration(m);
    const deadlineMs = realFutureDeadlineMs(o, nowMs);

    if (deadlineMs !== null) {
      const leadDays = APPLICATION_PREP_DAYS + (reg.required ? reg.leadDays : 0);
      const actionOffsetDays = (deadlineMs - nowMs) / DAY_MS - leadDays;
      const month =
        actionOffsetDays <= 0
          ? 1
          : clamp(Math.floor(actionOffsetDays / DAYS_PER_MONTH) + 1, 1, horizon);
      return { m, o, score, tier, reg, deadlineMs, month, flexible: false };
    }
    return { m, o, score, tier, reg, deadlineMs: null, month: 0, flexible: true };
  });

  // Second pass: place flexible (evergreen/rolling) programs. They TRAIL the
  // deadline-driven cluster and spread on a cadence — a suggested rhythm, NOT an
  // invented deadline. When there are no real deadlines at all, they simply
  // spread from the start of the horizon.
  const maxDeadlineMonth = prepared
    .filter((p) => !p.flexible)
    .reduce((mx, p) => Math.max(mx, p.month), 0);
  const flexStart = maxDeadlineMonth > 0 ? maxDeadlineMonth + 1 : 1;
  let flexRank = 0;
  for (const p of prepared) {
    if (!p.flexible) continue;
    p.month = clamp(flexStart + flexRank * 2, 1, horizon);
    flexRank += 1;
  }

  const items: FundingStrategyItem[] = prepared.map((p) => {
    const window: ActionWindow = {
      month: p.month,
      quarter: quarterOf(p.month),
      label: p.flexible ? "Flexible (rolling)" : `Month ${p.month} (${quarterOf(p.month)})`,
      flexible: p.flexible,
    };

    return {
      opportunity: p.o,
      score: p.score,
      tier: p.tier,
      deadline: p.deadlineMs !== null ? p.o.deadline ?? null : null,
      hasDeadline: p.deadlineMs !== null,
      requiresRegistration: p.reg.required,
      registrationLeadDays: p.reg.required ? p.reg.leadDays : 0,
      window,
      rationale: buildRationale({
        tier: p.tier,
        score: p.score,
        deadlineMs: p.deadlineMs,
        nowMs,
        requiresRegistration: p.reg.required,
        registrationLeadDays: p.reg.leadDays,
      }),
    };
  });

  // ORDER the list into a 12-month sequence: earliest action first. Real
  // deadlines sit ahead of flexible ones sharing a month; then best fit; then
  // name for a stable order.
  items.sort((a, b) => {
    if (a.window.month !== b.window.month) return a.window.month - b.window.month;
    if (a.hasDeadline !== b.hasDeadline) return a.hasDeadline ? -1 : 1;
    const fw = (TIER_WEIGHT[b.tier] ?? 0) - (TIER_WEIGHT[a.tier] ?? 0);
    if (fw !== 0) return fw;
    if (b.score !== a.score) return b.score - a.score;
    return nameOf(a.opportunity).localeCompare(nameOf(b.opportunity));
  });

  return {
    intro:
      `${items.length === 1 ? "One program" : `${countWord(items.length)} programs`} to investigate over the ` +
      `next ${horizon} months — a research plan, not a promise of funding. Deadlines shown are the ` +
      `programs' own; evergreen programs have none.`,
    items,
    registrationNote: buildRegistrationNote(items),
  };
}

// ---------------------------------------------------------------------------
// Ordering / comparison
// ---------------------------------------------------------------------------

/** Fit comparator: higher tier, then higher score, then name. Returns <0 if a is fitter. */
function compareFit(a: StrategyMatchLike, b: StrategyMatchLike): number {
  const fw = (TIER_WEIGHT[b.tier ?? ""] ?? 0) - (TIER_WEIGHT[a.tier ?? ""] ?? 0);
  if (fw !== 0) return fw;
  const sw = (b.score ?? 0) - (a.score ?? 0);
  if (sw !== 0) return sw;
  return programName(a).localeCompare(programName(b));
}

/** Selection comparator: fit first, then nearer real deadline, then name. */
function compareForSelection(a: StrategyMatchLike, b: StrategyMatchLike, nowMs: number): number {
  const f = compareFit(a, b);
  if (f !== 0) return f;
  const da = realFutureDeadlineMs(a.opportunity, nowMs) ?? Number.POSITIVE_INFINITY;
  const db = realFutureDeadlineMs(b.opportunity, nowMs) ?? Number.POSITIVE_INFINITY;
  if (da !== db) return da - db;
  return programName(a).localeCompare(programName(b));
}

function nameOf(o: StrategyOpportunityLike): string {
  return (o.title ?? o.program ?? o.agency ?? "").toString();
}

// ---------------------------------------------------------------------------
// Rationale / notes
// ---------------------------------------------------------------------------

function buildRationale(args: {
  tier: string;
  score: number;
  deadlineMs: number | null;
  nowMs: number;
  requiresRegistration: boolean;
  registrationLeadDays: number;
}): string {
  const parts: string[] = [`${tierPhrase(args.tier, args.score)}.`];

  if (args.deadlineMs !== null) {
    const days = Math.max(0, Math.round((args.deadlineMs - args.nowMs) / DAY_MS));
    parts.push(`Application deadline ${formatDate(args.deadlineMs)} (~${days} days out).`);
  } else {
    parts.push("Rolling / evergreen — no fixed deadline; investigate and apply when ready.");
  }

  if (args.requiresRegistration) {
    parts.push(
      `Federal registration (SAM.gov / UEI) is a prerequisite — allow ~${args.registrationLeadDays} days lead time, ` +
        "so start it now.",
    );
  }

  return parts.join(" ");
}

/**
 * Plan-level "start registration now" note. Emitted when ANY selected program
 * needs federal registration; it points at the FIRST real deadline in the plan
 * so the user registers ahead of it. Null when nothing needs registration.
 */
function buildRegistrationNote(items: FundingStrategyItem[]): string | null {
  const needsReg = items.some((it) => it.requiresRegistration);
  if (!needsReg) return null;

  const firstDeadline = items
    .filter((it) => it.hasDeadline && it.deadline)
    .map((it) => Date.parse(it.deadline as string))
    .filter((t) => !Number.isNaN(t))
    .sort((a, b) => a - b)[0];

  if (typeof firstDeadline === "number") {
    return (
      "Start your SAM.gov registration and UEI now — it commonly takes several weeks — so it is active " +
      `before your first hard deadline (${formatDate(firstDeadline)}).`
    );
  }
  return (
    "Start your SAM.gov registration and UEI now — federal programs require it and it commonly takes " +
    "several weeks, so do it before you need it."
  );
}

function countWord(n: number): string {
  const words = ["Zero", "One", "Two", "Three", "Four", "Five"];
  return words[n] ?? String(n);
}
