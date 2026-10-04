import type { CompanyProfile, EntityType, Certification } from "../contracts/companyProfile";
import type { Opportunity, EligibilityRule, EligibilityRuleCategory } from "../contracts/opportunity";
import type { Provenance, Citation } from "../contracts/primitives";
import {
  EligibilityDeterminationSchema,
  type EligibilityDetermination,
  type RuleEvaluation,
  type RequiredStep,
} from "../contracts/eligibilityDetermination";
import {
  universalRulesForOpportunity,
  type UniversalRule,
} from "./universalRules";

/**
 * screen.ts — ELG-01, the R8 eligibility screening engine (three buckets).
 *
 * PURE LOGIC, NO LLM. Given a `CompanyProfile`, an `Opportunity`, and the
 * per-opportunity eligibility rules, produce a CON-01 `EligibilityDetermination`
 * sorting the opportunity into exactly one bucket:
 *
 *   - `eligible`               — the profile satisfies every gate the Canon has
 *                                a rule for (R8.2).
 *   - `conditionally_eligible` — reachable after a concrete step (e.g. register
 *                                in SAM.gov), shown WITH the step + its lead time.
 *   - `excluded`               — with the reason and the rule cited. Never
 *                                silently dropped; the reason is always shown.
 *   - `unknown`                — a gate the profile/rules do not settle. Never
 *                                guessed eligible OR ineligible (R8.2).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE SAFETY INVARIANTS THIS MODULE ENFORCES (R8.4 / §11) — do not weaken:
 *
 *  1. A `model_inferred` rule ALONE never yields `excluded`. A rule may only
 *     drive an exclusion if it is human-reviewed (`provenance` is `verified` —
 *     or, allowed by the CON-01 schema, `user_stated`). Everything CAN-04 writes
 *     is `model_inferred`; the universal overlay is authoritative-CITED but still
 *     agent-curated (unreviewed). Neither may drive `excluded`.
 *
 *  2. A `model_inferred` PROFILE FACT is never sufficient to exclude. Even a
 *     reviewed rule that a fact appears to violate cannot exclude when that fact
 *     was itself only inferred — the honest answer is `unknown` ("confirm this
 *     and we'll screen it"), not a guess.
 *
 *  3. The universal registration gate (SAM.gov / UEI) is CONDITIONAL — it
 *     becomes a `required_step` with a lead time, NEVER an exclusion.
 *
 *  4. The universal SBIR/STTR size + ownership gates apply only to SBIR/STTR
 *     opportunities and, being unreviewed, inform-but-do-not-hard-exclude: an
 *     apparent violation renders `unknown` (pending human review), never
 *     `excluded`.
 *
 *  5. A gate the profile does not settle renders `unknown`, never a guess.
 *
 * DEFENSE IN DEPTH: the value returned is validated through
 * `EligibilityDeterminationSchema.parse(...)`, whose own refinements refuse an
 * `excluded` bucket that (a) cites no failed rule or (b) rests only on
 * `model_inferred` rules. A logic bug that tried to emit such an exclusion would
 * THROW here rather than reach the UI.
 * ─────────────────────────────────────────────────────────────────────────────
 */

// ---------------------------------------------------------------------------
// Structured predicates — the machine-evaluable form of a gate
// ---------------------------------------------------------------------------

/**
 * A structured, deterministically-evaluable predicate for a gate. The CON-01
 * `EligibilityRule` carries only a category + free-text `description`; a pure
 * engine cannot safely infer a pass/fail from prose (that would be model work,
 * and a wrong parse is a false exclusion — the single worst failure here). So
 * the engine evaluates ONLY rules that arrive with one of these predicates. The
 * universal overlay is mapped to predicates internally; per-opportunity rules
 * supply theirs via `ScreeningRule.predicate` — either a reviewed rule-structuring
 * layer (`fromEligibilityRule(rule, { predicate })`, the H10 reviewed-rule path)
 * or the deterministic safe-category mapper (`safeCategoryPredicate`), or the
 * fixtures/tests. A rule with no recognized predicate is advisory: it is never a
 * gate and never affects the bucket.
 */
export type RulePredicate =
  /** Eligible only if the profile's entity type is one of `allowed`. */
  | { kind: "entity_type_in"; allowed: EntityType[] }
  /** Excluded if the profile's entity type is one of `disallowed`. */
  | { kind: "entity_type_not_in"; disallowed: EntityType[] }
  /** Requires majority US ownership (`profile.us_owned === true`). */
  | { kind: "us_ownership_required" }
  /** Requires `profile.employee_count <= max`. */
  | { kind: "max_employees"; max: number }
  /** Requires an active SAM.gov registration (conditional — a step, not a bar). */
  | { kind: "sam_registration_required" }
  /** Requires a UEI (conditional — folded into the SAM step). */
  | { kind: "uei_required" }
  /** Requires a location/designation in the allowed set. */
  | { kind: "geography_in"; allowed_locations?: string[]; allowed_designations?: string[] }
  /** Program-specific prior-award prerequisite (e.g. Phase II requires Phase I). */
  | { kind: "prior_award_required" }
  /** Requires at least one of the named federal certifications. */
  | { kind: "certification_required"; any_of: Certification[] };

/**
 * The engine's input rule shape. An additive superset of the CON-01
 * `EligibilityRule` (it does NOT widen the shared contract): a plain
 * `EligibilityRule` is a valid `ScreeningRule` with `predicate` undefined.
 */
export interface ScreeningRule {
  id: string;
  category: EligibilityRuleCategory;
  description: string;
  /** Rule provenance. `verified`/`user_stated` = reviewed (may gate exclusion). */
  provenance: Provenance;
  citation?: Citation;
  /** The machine-evaluable predicate, if this rule has been structured. */
  predicate?: RulePredicate;
  /**
   * `conditional` → an unmet gate is a step (registration), never an exclusion.
   * `categorical` → a hard eligibility fact. Defaults to `categorical`.
   */
  gate_kind?: "conditional" | "categorical";
  /** Internal: universal-overlay rules are authoritative-cited but UNREVIEWED. */
  _origin?: "per_opp" | "universal";
}

/**
 * The minimal opportunity shape the engine reads. `kind` routes the kind-scoped
 * universal gates (loan → for-profit, scholarship → individual, procurement →
 * FAR SAM registration); it is optional so legacy callers still screen correctly
 * (an unknown kind is treated as federal financial assistance).
 */
export type ScreenableOpportunity = Pick<Opportunity, "id"> &
  Partial<Pick<Opportunity, "program" | "title" | "eligibility_rules" | "kind" | "source">>;

// ---------------------------------------------------------------------------
// SAM.gov registration lead time (R8.2 "show the lead time it needs")
// ---------------------------------------------------------------------------

/**
 * Typical lead time for an active SAM.gov registration + UEI. The controlling
 * guidance (2 CFR 25.200, cited in `universalRules.ts`) says only "several
 * weeks"; this constant encodes a conservative typical MINIMUM so the UI can show
 * a concrete number. It is a planning estimate, not a fixed legal fact — the
 * qualitative caveat rides along in the step's `why`.
 */
export const SAM_REGISTRATION_LEAD_TIME_DAYS = 21;

// ---------------------------------------------------------------------------
// Provenance helpers
// ---------------------------------------------------------------------------

const PROVENANCE_RANK: Record<Provenance, number> = {
  model_inferred: 0,
  user_stated: 1,
  verified: 2,
};

/** The weaker (less trustworthy) of two provenances — `model_inferred` wins. */
function weakestProvenance(a: Provenance, b: Provenance): Provenance {
  return PROVENANCE_RANK[a] <= PROVENANCE_RANK[b] ? a : b;
}

/** A profile fact is trustworthy enough to GATE only if it was not merely inferred. */
function isTrustworthyFact(p: Provenance | undefined): boolean {
  return p === "user_stated" || p === "verified";
}

/** A RULE may drive an exclusion only if it has been human-reviewed. */
function ruleMayExclude(r: ScreeningRule): boolean {
  // Universal-overlay rules are authoritative-cited but UNREVIEWED → never gate.
  if (r._origin === "universal") return false;
  // CAN-04 writes `model_inferred`; only a review promotes a rule to `verified`.
  return r.provenance === "verified" || r.provenance === "user_stated";
}

// ---------------------------------------------------------------------------
// Reading provenanced profile fields
// ---------------------------------------------------------------------------

type ProvField<T> = { value: T; provenance: Provenance; confidence: number };
interface FactRead<T> {
  present: boolean;
  value?: T;
  provenance?: Provenance;
}
function readFact<T>(f: ProvField<T> | undefined): FactRead<T> {
  if (!f) return { present: false };
  return { present: true, value: f.value, provenance: f.provenance };
}

// ---------------------------------------------------------------------------
// Predicate evaluation
// ---------------------------------------------------------------------------

type Verdict = "pass" | "fail" | "indeterminate";
interface PredResult {
  verdict: Verdict;
  /** Provenance of the profile fact the verdict rests on (if any fact was read). */
  factProvenance?: Provenance;
}

const IND: PredResult = { verdict: "indeterminate" };

/** Evaluate one predicate against the profile. Pure; reads only structured facts. */
function evaluatePredicate(pred: RulePredicate, profile: CompanyProfile): PredResult {
  switch (pred.kind) {
    case "entity_type_in": {
      const f = readFact(profile.entity_type);
      if (!f.present) return IND;
      return {
        verdict: pred.allowed.includes(f.value as EntityType) ? "pass" : "fail",
        factProvenance: f.provenance,
      };
    }
    case "entity_type_not_in": {
      const f = readFact(profile.entity_type);
      if (!f.present) return IND;
      return {
        verdict: pred.disallowed.includes(f.value as EntityType) ? "fail" : "pass",
        factProvenance: f.provenance,
      };
    }
    case "us_ownership_required": {
      const f = readFact(profile.us_owned);
      if (!f.present) return IND;
      return { verdict: f.value ? "pass" : "fail", factProvenance: f.provenance };
    }
    case "max_employees": {
      const f = readFact(profile.employee_count);
      if (!f.present || typeof f.value !== "number") return IND;
      return {
        verdict: f.value <= pred.max ? "pass" : "fail",
        factProvenance: f.provenance,
      };
    }
    case "sam_registration_required": {
      const f = readFact(profile.sam_registered);
      if (!f.present) return IND; // don't know → routed to a step, never a bar
      return { verdict: f.value ? "pass" : "fail", factProvenance: f.provenance };
    }
    case "uei_required": {
      const f = readFact(profile.uei);
      if (!f.present) return IND;
      const has = typeof f.value === "string" && f.value.trim().length > 0;
      return { verdict: has ? "pass" : "fail", factProvenance: f.provenance };
    }
    case "prior_award_required": {
      const f = readFact(profile.prior_federal_funding);
      if (!f.present) return IND;
      return { verdict: f.value ? "pass" : "fail", factProvenance: f.provenance };
    }
    case "certification_required": {
      const f = readFact(profile.certifications);
      if (!f.present || !Array.isArray(f.value)) return IND;
      const have = new Set(f.value as Certification[]);
      return {
        verdict: pred.any_of.some((c) => have.has(c)) ? "pass" : "fail",
        factProvenance: f.provenance,
      };
    }
    case "geography_in": {
      // Conservative: only a clear DESIGNATION mismatch can fail. Free-text
      // locations are too ambiguous to fail on without risking a false
      // exclusion, so an unmatched location stays `indeterminate` (→ unknown).
      if (pred.allowed_designations && pred.allowed_designations.length > 0) {
        const f = readFact(profile.geography_designations);
        if (f.present && Array.isArray(f.value)) {
          const have = new Set((f.value as string[]).map((s) => s.toLowerCase()));
          const ok = pred.allowed_designations.some((d) => have.has(d.toLowerCase()));
          return { verdict: ok ? "pass" : "fail", factProvenance: f.provenance };
        }
      }
      return IND;
    }
  }
}

// ---------------------------------------------------------------------------
// Universal overlay → ScreeningRule
// ---------------------------------------------------------------------------

/** Map a universal-overlay rule to its structured predicate. */
function universalPredicate(u: UniversalRule): RulePredicate | undefined {
  if (u.category === "registration") return { kind: "sam_registration_required" };
  if (u.id.includes("ownership")) return { kind: "us_ownership_required" };
  // 13 CFR 121.702(c): "not more than 500 employees" (mirrors the cited quote).
  if (u.id.includes("size")) return { kind: "max_employees", max: 500 };
  // Kind gates (loan / scholarship). Both are `categorical` + UNREVIEWED, so an
  // apparent entity-type mismatch renders `unknown` (needs review), never
  // `excluded` (R8.4) — ruleMayExclude() returns false for `_origin: "universal"`.
  // 13 CFR 120.100: SBA business loans require a for-profit applicant.
  if (u.id === "universal-loan-for-profit") {
    return { kind: "entity_type_in", allowed: ["for_profit_small_business", "for_profit_other"] };
  }
  // 34 CFR 75.62(a): scholarships/fellowships are awarded to individuals.
  if (u.id === "universal-scholarship-individual") {
    return { kind: "entity_type_in", allowed: ["individual"] };
  }
  return undefined;
}

function universalToScreeningRule(u: UniversalRule): ScreeningRule {
  return {
    id: u.id,
    category: u.category,
    description: u.description,
    // Downcast the overlay's `authoritative` provenance to `model_inferred` for
    // GATING purposes only: these rules are unreviewed, so — like a model rule —
    // they must never drive an exclusion. Defense in depth: if a bug ever routed
    // one into `failed_rules`, the schema's R8.4 refinement would THROW. The
    // authoritative CFR sourcing is preserved for display in `citation`.
    provenance: "model_inferred",
    citation: u.citation,
    predicate: universalPredicate(u),
    gate_kind: u.gate_kind,
    _origin: "universal",
  };
}

// ---------------------------------------------------------------------------
// RuleEvaluation builders
// ---------------------------------------------------------------------------

function toEvaluation(r: ScreeningRule, provenance: Provenance): RuleEvaluation {
  const e: RuleEvaluation = {
    rule_id: r.id,
    category: r.category,
    description: r.description,
    provenance,
  };
  if (r.citation) e.citation = r.citation;
  return e;
}

// ---------------------------------------------------------------------------
// The screen() entry point
// ---------------------------------------------------------------------------

/**
 * Screen one opportunity against the profile and its rules → an
 * `EligibilityDetermination`. `rules` are the per-opportunity screening rules;
 * if omitted, `opportunity.eligibility_rules` is used (advisory — those carry no
 * predicate). The universal overlay is ALWAYS folded in via
 * `universalRulesForOpportunity`.
 */
export function screen(
  profile: CompanyProfile,
  opportunity: ScreenableOpportunity,
  rules?: ScreeningRule[],
): EligibilityDetermination {
  const perOpp: ScreeningRule[] =
    rules ??
    // Structure each CON-01 rule into a ScreeningRule. `mapSafeCategories`
    // attaches a predicate ONLY for the deterministically-safe categories (today:
    // `registration` → a CONDITIONAL SAM.gov step — never an exclusion). Every
    // other category needs free-text parsing to build a predicate, which this
    // engine refuses, so it stays advisory (no predicate) exactly as before. The
    // explicit arrow also avoids `.map`'s (element, index, array) footgun feeding
    // the array index in as the options argument.
    (opportunity.eligibility_rules ?? []).map((r) =>
      fromEligibilityRule(r, { mapSafeCategories: true }),
    );

  const universal = universalRulesForOpportunity({
    title: opportunity.title ?? "",
    program: opportunity.program ?? "",
    // Kind routes the kind-scoped universal gates (loan/scholarship/procurement).
    kind: opportunity.kind,
    // Source gates ALL universal rules to federal opportunities only (see
    // UniversalRuleOpportunity's `source` doc) — a state grant must never
    // get a SAM.gov/UEI or SBA "organized for profit" requirement.
    source: opportunity.source,
  }).map(universalToScreeningRule);

  const allRules: ScreeningRule[] = [...universal, ...perOpp];

  const satisfied: RuleEvaluation[] = [];
  const failed: RuleEvaluation[] = [];
  const unknown: RuleEvaluation[] = [];
  const steps: RequiredStep[] = [];

  // Bucket is decided by these flags, NOT by list non-emptiness — so advisory
  // rules can be surfaced without wrongly downgrading a clear determination.
  let hasExclusion = false;
  let hasUndeterminedHardGate = false;
  let hasStep = false;

  for (const r of allRules) {
    const isConditional = r.gate_kind === "conditional";

    if (!r.predicate) {
      // No machine-evaluable predicate → the engine cannot screen this rule.
      // A REVIEWED categorical gate we cannot evaluate is a genuine unknown
      // (there's a hard gate; we just can't settle it). Advisory/unreviewed
      // prose is skipped so it never downgrades an otherwise-clear opp.
      if (!isConditional && ruleMayExclude(r)) {
        unknown.push(toEvaluation(r, r.provenance));
        hasUndeterminedHardGate = true;
      }
      continue;
    }

    const res = evaluatePredicate(r.predicate, profile);

    if (res.verdict === "pass") {
      satisfied.push(toEvaluation(r, res.factProvenance ?? r.provenance));
      continue;
    }

    if (isConditional) {
      // Registration gate: unmet OR undetermined → a step with lead time.
      // Never an exclusion, never blocks "eligible" as unknown.
      steps.push(registrationStep(r));
      hasStep = true;
      continue;
    }

    if (res.verdict === "indeterminate") {
      // A hard categorical gate the profile does not settle → unknown (R8.2:
      // "eligibility depends on X — tell us and we'll screen this").
      unknown.push(toEvaluation(r, r.provenance));
      hasUndeterminedHardGate = true;
      continue;
    }

    // verdict === "fail" on a categorical gate.
    const factTrustworthy = isTrustworthyFact(res.factProvenance);
    if (ruleMayExclude(r) && factTrustworthy) {
      // The ONLY path to `excluded`: a reviewed rule + a trustworthy failing
      // fact. Provenance emitted is the weaker of the two (both non-inferred
      // here) so the schema's R8.4 refinement is satisfied.
      const prov = weakestProvenance(r.provenance, res.factProvenance as Provenance);
      failed.push(toEvaluation(r, prov));
      hasExclusion = true;
      continue;
    }

    // Cannot exclude: rule is unreviewed/model_inferred, OR the failing fact was
    // itself only inferred. Render as UNKNOWN (needs review / confirmation),
    // never `excluded` (R8.4, R8.2).
    unknown.push(needsReviewEvaluation(r, res.factProvenance));
    hasUndeterminedHardGate = true;
  }

  // Bucket precedence: excluded > unknown > conditionally_eligible > eligible.
  // `unknown` outranks `conditional` because an unsettled HARD gate means we
  // cannot promise that a step alone unlocks the opportunity.
  let bucket: EligibilityDetermination["bucket"];
  if (hasExclusion) bucket = "excluded";
  else if (hasUndeterminedHardGate) bucket = "unknown";
  else if (hasStep) bucket = "conditionally_eligible";
  else bucket = "eligible";

  const determination = {
    opportunity_id: opportunity.id,
    bucket,
    satisfied_rules: satisfied,
    failed_rules: failed,
    unknown_rules: unknown,
    required_steps: dedupeSteps(steps),
  };

  // Defense in depth (R8.4 / R8.2): validate through the CON-01 schema, whose
  // refinements reject a silent or model_inferred-only exclusion.
  return EligibilityDeterminationSchema.parse(determination);
}

// ---------------------------------------------------------------------------
// Small builders
// ---------------------------------------------------------------------------

/**
 * DETERMINISTIC category → predicate mapper (H10). Maps ONLY the SAFE,
 * unambiguous categories where the structured `EligibilityRuleCategory` ALONE
 * implies a predicate with ZERO free-text parsing:
 *
 *   - `registration` → `{ kind: "sam_registration_required" }`, gate_kind
 *     `conditional`. Safe for ANY provenance: a conditional gate can only ever
 *     become a `required_step` or a `satisfied` — NEVER an `excluded` and never
 *     even an `unknown` (invariant 3). So even a `model_inferred` registration
 *     rule can at most add a SAM.gov step (→ `conditionally_eligible`).
 *
 * Every other category is left `undefined` (advisory, exactly as today). They
 * need free-text parsing to build a predicate — an entity list, an employee
 * NUMBER, a designation, a cert list, an ownership assertion — which is exactly
 * the fabrication risk this engine refuses. In particular `size_ownership` is
 * deliberately NOT mapped: it conflates a size gate (a number that would have to
 * be parsed from prose) with an ownership gate, so it is ambiguous and stays
 * advisory rather than risking a wrong parse → a false exclusion.
 */
export function safeCategoryPredicate(
  category: EligibilityRuleCategory,
): { predicate: RulePredicate; gate_kind: "conditional" | "categorical" } | undefined {
  if (category === "registration") {
    return { predicate: { kind: "sam_registration_required" }, gate_kind: "conditional" };
  }
  return undefined;
}

/** Default gate kind for a supplied predicate (only registration is conditional). */
function defaultGateKind(pred: RulePredicate): "conditional" | "categorical" {
  return pred.kind === "sam_registration_required" ? "conditional" : "categorical";
}

/** Options for structuring a per-opportunity `EligibilityRule` into a `ScreeningRule`. */
export interface FromEligibilityRuleOptions {
  /**
   * REVIEWED-RULE PATH (H10). A structured, machine-evaluable predicate supplied
   * by a rule-structuring / review layer — NOT inferred from prose by this engine
   * (that would be a fabrication risk). When present, the resulting rule can be
   * gated by `screen()`. It gates an EXCLUSION only through the engine's existing
   * single exclusion path, which additionally requires the rule's `provenance` to
   * be reviewed (`verified`/`user_stated`) AND the failing profile fact to be
   * trustworthy. A `model_inferred` predicate can therefore reach only `unknown`
   * (a failing categorical gate) or `conditionally_eligible` (a conditional
   * gate) — NEVER `excluded`.
   */
  predicate?: RulePredicate;
  /** Override the gate kind (otherwise derived from the predicate/category). */
  gate_kind?: "conditional" | "categorical";
  /**
   * Apply the deterministic `safeCategoryPredicate` mapper when no explicit
   * `predicate` is supplied. OFF by default so callers that pass no options get
   * byte-identical output to the legacy behavior (a plain advisory rule, no
   * predicate).
   */
  mapSafeCategories?: boolean;
}

/**
 * Map a CON-01 `EligibilityRule` to a `ScreeningRule`.
 *
 * With no options this is the legacy behavior: an advisory rule with NO
 * predicate (never a gate). Supply `opts.predicate` (the reviewed-rule path) or
 * `opts.mapSafeCategories` (the deterministic safe-category mapper) to give the
 * rule a machine-evaluable predicate so `screen()` can act on it.
 *
 * SAFETY: this only structures the rule; it does NOT weaken any screen()
 * invariant. Whether a predicated rule can drive `excluded` is decided solely by
 * screen()'s unchanged exclusion path (reviewed provenance + trustworthy fact).
 * A `model_inferred` rule reaches at most `unknown`/`conditionally_eligible`.
 */
export function fromEligibilityRule(
  r: EligibilityRule,
  opts: FromEligibilityRuleOptions = {},
): ScreeningRule {
  const rule: ScreeningRule = {
    id: r.id,
    category: r.category,
    description: r.description,
    provenance: r.provenance,
    citation: r.citation,
    _origin: "per_opp",
  };

  const mapped =
    opts.predicate !== undefined
      ? { predicate: opts.predicate, gate_kind: defaultGateKind(opts.predicate) }
      : opts.mapSafeCategories
        ? safeCategoryPredicate(r.category)
        : undefined;

  if (mapped) {
    rule.predicate = mapped.predicate;
    rule.gate_kind = opts.gate_kind ?? mapped.gate_kind;
  } else if (opts.gate_kind) {
    rule.gate_kind = opts.gate_kind;
  }

  return rule;
}

function registrationStep(r: ScreeningRule): RequiredStep {
  return {
    step:
      r.category === "registration"
        ? "Register the entity in SAM.gov and obtain a UEI before the application deadline."
        : r.description,
    lead_time_days: SAM_REGISTRATION_LEAD_TIME_DAYS,
    why:
      "SAM.gov registration commonly takes several weeks — start well before a deadline. " +
      "This is a timeline blocker, not an eligibility bar.",
  };
}

function needsReviewEvaluation(
  r: ScreeningRule,
  factProvenance: Provenance | undefined,
): RuleEvaluation {
  const reason =
    r._origin === "universal"
      ? "Authoritative-but-unreviewed gate — informs eligibility but needs human review before it can affect it (R8.4)."
      : !isTrustworthyFact(factProvenance)
        ? "The profile fact this depends on was only inferred — confirm it and we'll screen this (R8.2)."
        : "Model-inferred rule — needs human review before it can affect eligibility (R8.4).";
  const e: RuleEvaluation = {
    rule_id: r.id,
    category: r.category,
    description: `${r.description} — ${reason}`,
    // Kept `model_inferred` on purpose: this evaluation must never be able to
    // stand as a reason for exclusion.
    provenance: "model_inferred",
  };
  if (r.citation) e.citation = r.citation;
  return e;
}

function dedupeSteps(steps: RequiredStep[]): RequiredStep[] {
  const seen = new Set<string>();
  const out: RequiredStep[] = [];
  for (const s of steps) {
    if (seen.has(s.step)) continue;
    seen.add(s.step);
    out.push(s);
  }
  return out;
}
