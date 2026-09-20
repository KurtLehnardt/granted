/**
 * Grant Readiness Score — pure, deterministic scoring core (GTM free tool).
 *
 * This module is the source of truth for the "Grant Readiness Score": a 0–100
 * grade + per-dimension breakdown + the single highest-leverage fix + an honest
 * verdict banner. It is intentionally framework-agnostic (no React, no DOM, no
 * network, no LLM) so the whole computation runs instantly client-side AND is
 * directly unit-testable, matching this repo's convention of pure exported
 * builders (see components/ApplicationChecklist.tsx).
 *
 * HONESTY BOUNDARY (mirrors the product's §11 / R8 posture): this scores a
 * user's *readiness to apply*, never their eligibility for a specific
 * program and never their odds of winning. The verdict copy is calibrated to
 * say "not yet" plainly (the brand's "honest no") rather than inflate a grade.
 * The three hard federal gates below (entity formed · SAM.gov Active · US-based
 * small business) are the rejection-causing ones, so they carry ~65% of the
 * grade — a high score is impossible while any of them is a blocker.
 *
 * The readiness requirements themselves reuse the real domain wording from
 * components/ApplicationChecklist.tsx (Active SAM.gov registration, the UEI
 * assigned when you begin that registration, the ~2-week lead time, etc.).
 */

// ---------------------------------------------------------------------------
// Answer shape (what the ~7-question form collects)
// ---------------------------------------------------------------------------

export type YesNo = "yes" | "no";
export type SamStatus = "active" | "in_progress" | "not_started";
/** For dimensions that have a meaningful middle ground. */
export type Tri = "yes" | "somewhat" | "no";
export type FundingBand = "under_50k" | "50k_250k" | "250k_1m" | "over_1m" | "unsure";

export interface ReadinessAnswers {
  /** Is the organization a legally formed entity (LLC, C-corp, nonprofit, …)? */
  entityFormed: YesNo;
  /** SAM.gov registration status — Active is the gate portals actually check. */
  samStatus: SamStatus;
  /** Does the org have a UEI (assigned when a SAM.gov registration is begun)? */
  hasUei: YesNo;
  /** US-based, for-profit small business (typically < 500 employees)? */
  usSmallBusiness: YesNo;
  /** A genuine R&D / technical-innovation component (the SBIR/STTR gate)? */
  rdComponent: Tri;
  /** A path to a product/market beyond the research itself? */
  commercialization: Tri;
  /** The user's target funding size (context/fit, not a hard gate). */
  fundingTarget: FundingBand;
}

// ---------------------------------------------------------------------------
// Result shape
// ---------------------------------------------------------------------------

export type DimensionStatus = "ready" | "in_progress" | "blocker";
export type VerdictLevel = "blocked" | "in_progress" | "ready";

export interface DimensionResult {
  key: keyof ReadinessAnswers;
  label: string;
  status: DimensionStatus;
  /** Max points this dimension can contribute to the 0–100 grade. */
  weight: number;
  /** Points actually earned (0..weight). */
  earned: number;
  /** True for the three rejection-causing hard federal gates. */
  hardGate: boolean;
  /** Prerequisite order (1 = fix earliest). Lower = higher leverage. */
  order: number;
  /** Short, honest, status-specific explanation for the breakdown row. */
  detail: string;
  /** Concrete next action when this dimension isn't ready (for the top fix). */
  fixAction: string;
}

export interface Verdict {
  level: VerdictLevel;
  /** One-line banner headline, in the app's plain, non-sycophantic voice. */
  headline: string;
  /** Supporting sentence — honest about the cost of applying too early. */
  detail: string;
}

export interface ReadinessResult {
  /** 0–100, rounded. */
  grade: number;
  dimensions: DimensionResult[];
  verdict: Verdict;
  /** The single highest-leverage fix, or null when everything is ready. */
  topFix: { label: string; action: string } | null;
}

// ---------------------------------------------------------------------------
// Static per-dimension metadata (labels/weights/order) — shared with the UI.
// ---------------------------------------------------------------------------

export const DIMENSION_META: Record<
  keyof ReadinessAnswers,
  { label: string; weight: number; hardGate: boolean; order: number }
> = {
  entityFormed: { label: "Legally formed entity", weight: 20, hardGate: true, order: 1 },
  usSmallBusiness: { label: "US-based small business", weight: 20, hardGate: true, order: 2 },
  samStatus: { label: "Active SAM.gov registration", weight: 25, hardGate: true, order: 3 },
  hasUei: { label: "UEI (Unique Entity Identifier)", weight: 10, hardGate: false, order: 4 },
  rdComponent: { label: "R&D / technical innovation", weight: 10, hardGate: false, order: 5 },
  commercialization: { label: "Commercialization path", weight: 10, hardGate: false, order: 6 },
  fundingTarget: { label: "Funding-amount fit", weight: 5, hardGate: false, order: 7 },
};

/** Total is exactly 100 by construction; asserted by the unit tests. */
export const MAX_GRADE = 100;

// ---------------------------------------------------------------------------
// Per-dimension scoring — each returns { status, earned, detail, fixAction }.
// ---------------------------------------------------------------------------

type Scored = Pick<DimensionResult, "status" | "earned" | "detail" | "fixAction">;

function scoreEntity(a: ReadinessAnswers): Scored {
  const w = DIMENSION_META.entityFormed.weight;
  if (a.entityFormed === "yes") {
    return {
      status: "ready",
      earned: w,
      detail: "Federal funding goes to registered organizations, and yours is formed.",
      fixAction: "",
    };
  }
  return {
    status: "blocker",
    earned: 0,
    detail: "Federal awards go to organizations, not individuals — you'll need a formed entity first.",
    fixAction: "Form your entity (LLC, C-corp, nonprofit, …) — it's the prerequisite for every step below.",
  };
}

function scoreSmallBusiness(a: ReadinessAnswers): Scored {
  const w = DIMENSION_META.usSmallBusiness.weight;
  if (a.usSmallBusiness === "yes") {
    return {
      status: "ready",
      earned: w,
      detail: "A US-based small business meets the core eligibility most federal programs require.",
      fixAction: "",
    };
  }
  return {
    status: "blocker",
    earned: 0,
    detail:
      "Most small-business funding (SBIR/STTR and many grants) requires a US-based, for-profit small business — typically under 500 employees.",
    fixAction:
      "Confirm your size/ownership against the specific program's requirements — this gate rules out most small-business tracks.",
  };
}

function scoreSam(a: ReadinessAnswers): Scored {
  const w = DIMENSION_META.samStatus.weight;
  if (a.samStatus === "active") {
    return {
      status: "ready",
      earned: w,
      detail: "Active is exactly the status federal portals check before they'll accept an application.",
      fixAction: "",
    };
  }
  if (a.samStatus === "in_progress") {
    return {
      status: "in_progress",
      // ~40% credit: started counts for something, but only Active clears the gate.
      earned: Math.round(w * 0.4),
      detail: "Started, but not yet Active — and Active is the only status that lets you apply or be paid.",
      fixAction: "Finish your SAM.gov registration to Active — a new one can take up to ~2 weeks, so start the clock now.",
    };
  }
  return {
    status: "blocker",
    earned: 0,
    detail: "No SAM.gov registration — applications from entities that aren't Active are rejected outright.",
    fixAction: "Begin your SAM.gov registration now — it can take up to ~2 weeks to reach Active, and nothing can apply without it.",
  };
}

function scoreUei(a: ReadinessAnswers): Scored {
  const w = DIMENSION_META.hasUei.weight;
  if (a.hasUei === "yes") {
    return {
      status: "ready",
      earned: w,
      detail: "Your 12-character federal ID is in hand — portals can find your organization.",
      fixAction: "",
    };
  }
  return {
    status: "in_progress",
    earned: 0,
    detail: "A UEI is assigned when you begin a SAM.gov registration — it arrives with that step, not separately.",
    fixAction: "Start your SAM.gov registration; the UEI is issued as part of it.",
  };
}

function scoreRd(a: ReadinessAnswers): Scored {
  const w = DIMENSION_META.rdComponent.weight;
  if (a.rdComponent === "yes") {
    return {
      status: "ready",
      earned: w,
      detail: "A genuine technical-innovation component opens the SBIR/STTR R&D track.",
      fixAction: "",
    };
  }
  if (a.rdComponent === "somewhat") {
    return {
      status: "in_progress",
      earned: Math.round(w * 0.5),
      detail: "Some innovation, but a strong SBIR/STTR case needs a clear technical risk or unknown you're resolving.",
      fixAction: "Sharpen the specific technical unknown your work resolves — that's what the R&D track funds.",
    };
  }
  return {
    status: "blocker",
    earned: 0,
    detail: "Without an R&D component the SBIR/STTR track is out — though grants, procurement, and loans may still fit.",
    fixAction: "If SBIR/STTR is the goal, define a real technical innovation; otherwise focus on non-R&D programs.",
  };
}

function scoreCommercialization(a: ReadinessAnswers): Scored {
  const w = DIMENSION_META.commercialization.weight;
  if (a.commercialization === "yes") {
    return {
      status: "ready",
      earned: w,
      detail: "A credible path to market strengthens nearly every federal application.",
      fixAction: "",
    };
  }
  if (a.commercialization === "somewhat") {
    return {
      status: "in_progress",
      earned: Math.round(w * 0.5),
      detail: "A rough commercialization idea helps — reviewers reward a concrete one.",
      fixAction: "Write a one-paragraph commercialization plan: who buys this, and how it reaches them.",
    };
  }
  return {
    status: "in_progress",
    earned: 0,
    detail: "A commercialization path strengthens applications but is rarely a hard eligibility gate.",
    fixAction: "Sketch how the work reaches a customer or market — it lifts scores even when it isn't required.",
  };
}

function scoreFunding(a: ReadinessAnswers): Scored {
  const w = DIMENSION_META.fundingTarget.weight;
  if (a.fundingTarget === "unsure") {
    return {
      status: "in_progress",
      earned: Math.round(w * 0.4),
      detail: "Knowing your target size helps match you to programs whose award ranges actually fit.",
      fixAction: "Estimate the funding you need — it narrows which programs are worth your time.",
    };
  }
  return {
    status: "ready",
    earned: w,
    detail: "A target funding size lets us match you to programs whose award ranges fit.",
    fixAction: "",
  };
}

// ---------------------------------------------------------------------------
// Verdict — blocker-driven and deterministic, NOT purely numeric. A user can
// score in the 70s and still be a guaranteed rejection if a hard gate is a
// blocker, so the honest banner keys off the prerequisite chain first.
// ---------------------------------------------------------------------------

function computeVerdict(a: ReadinessAnswers): Verdict {
  // Order mirrors the prerequisite chain: entity → eligibility → SAM → UEI.
  if (a.entityFormed === "no") {
    return {
      level: "blocked",
      headline: "You're not application-ready yet — you need a legally formed entity first.",
      detail:
        "Federal funding goes to organizations, not individuals. Form your entity, then start SAM.gov — applying before that is a guaranteed rejection.",
    };
  }
  if (a.usSmallBusiness === "no") {
    return {
      level: "blocked",
      headline: "Most federal small-business funding won't fit yet.",
      detail:
        "SBIR/STTR and many grants require a US-based, for-profit small business (typically under 500 employees). We'd tell you honestly not to spend weeks on those applications until that's true.",
    };
  }
  if (a.samStatus === "not_started") {
    return {
      level: "blocked",
      headline: "You're not registration-ready yet.",
      detail:
        "Completing SAM.gov (a new registration can take up to ~2 weeks) before you apply will save you a guaranteed rejection — portals reject entities that aren't Active.",
    };
  }
  if (a.samStatus === "in_progress") {
    return {
      level: "in_progress",
      headline: "You're almost registration-ready.",
      detail:
        "Your SAM.gov registration is underway but not Active yet — and Active is the status portals check. Finish it and you'll clear the gate that rejects most first-time applicants.",
    };
  }
  if (a.hasUei === "no") {
    return {
      level: "in_progress",
      headline: "You're almost registration-ready.",
      detail:
        "Your UEI is assigned when you begin a SAM.gov registration — confirm it's in hand and your registration shows Active before you apply.",
    };
  }
  return {
    level: "ready",
    headline: "You're grant-ready — see which federal programs actually fit.",
    detail:
      "You clear the hard federal gates that reject most first-time applicants. The real question now isn't whether you can apply — it's which programs are worth your weeks.",
  };
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Compute the full readiness result from a complete set of answers. Pure and
 * total — every branch of every input maps to a defined output; it never throws.
 */
export function scoreReadiness(a: ReadinessAnswers): ReadinessResult {
  const scored: Record<keyof ReadinessAnswers, Scored> = {
    entityFormed: scoreEntity(a),
    usSmallBusiness: scoreSmallBusiness(a),
    samStatus: scoreSam(a),
    hasUei: scoreUei(a),
    rdComponent: scoreRd(a),
    commercialization: scoreCommercialization(a),
    fundingTarget: scoreFunding(a),
  };

  const keys = Object.keys(DIMENSION_META) as (keyof ReadinessAnswers)[];
  const dimensions: DimensionResult[] = keys.map((key) => {
    const meta = DIMENSION_META[key];
    const s = scored[key];
    return {
      key,
      label: meta.label,
      weight: meta.weight,
      hardGate: meta.hardGate,
      order: meta.order,
      status: s.status,
      earned: s.earned,
      detail: s.detail,
      fixAction: s.fixAction,
    };
  });

  const grade = Math.round(dimensions.reduce((sum, d) => sum + d.earned, 0));

  // Highest-leverage fix = the not-ready dimension earliest in the prerequisite
  // chain (lowest `order`). This respects real dependencies — no point telling a
  // user to finish SAM before they've formed an entity — and prefers the
  // universal registration gates over the track-specific R&D/commercialization
  // ones, which only affect some programs.
  const notReady = dimensions.filter((d) => d.status !== "ready").sort((x, y) => x.order - y.order);
  const top = notReady[0];
  const topFix = top ? { label: top.label, action: top.fixAction } : null;

  return {
    grade,
    dimensions,
    verdict: computeVerdict(a),
    topFix,
  };
}

/** Fully-ready answers — a convenience baseline for tests and the UI reset. */
export const IDEAL_ANSWERS: ReadinessAnswers = {
  entityFormed: "yes",
  usSmallBusiness: "yes",
  samStatus: "active",
  hasUei: "yes",
  rdComponent: "yes",
  commercialization: "yes",
  fundingTarget: "50k_250k",
};
