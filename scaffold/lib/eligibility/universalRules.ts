import { z } from "zod";
import { EligibilityRuleCategorySchema, FEDERAL_SOURCES } from "../contracts/opportunity";
import type { OpportunityKind, OpportunitySource } from "../contracts/opportunity";
import { CitationSchema } from "../contracts/primitives";
import type { CanonOpportunity } from "./CanonOpportunity";

/**
 * Used to live in lib/canon/rules.ts (CAN-04's per-NOFO extractor), relocated
 * here when the Supabase-backed Canon ingestion pipeline was retired (Granted
 * is local-only now) -- this schema itself has no DB dependency, it's just a
 * stricter citation shape than the base CitationSchema (source_url + quote
 * both required, not optional) for a rule that's curated in code rather than
 * extracted by a model, so it still needs to be genuinely grounded.
 */
const CitedCitationSchema = CitationSchema.extend({
  source_url: z.string().url(),
  quote: z.string().min(1),
});

/**
 * universalRules.ts — CAN-04 "universal overlay".
 *
 * WHY THIS EXISTS: our corpus is grants.gov-only, and grants.gov NOFO prose
 * rarely restates the *universal* federal gates (SAM.gov/UEI registration; the
 * SBIR/STTR size + ownership standards). The per-NOFO extractor in `rules.ts`
 * therefore — correctly — leaves those gates UNKNOWN rather than inventing a
 * per-NOFO "SAM required" rule (that fabricated-universal-rule move is exactly
 * what §11 forbids). This module supplies those gates ONCE, as a curated set
 * cited to authoritative federal regulations, so R8 can surface them without any
 * fabrication.
 *
 * DISTINCT FROM per-NOFO extraction:
 *  - `provenance = 'authoritative'`, `model_inferred = false` (these are cited to
 *    the controlling CFR, not inferred from a NOFO's text). `rules.ts`'s
 *    `insertEligibilityRules({replace:true})` scopes its delete to
 *    `model_inferred = true` precisely so re-running extraction never clobbers
 *    these.
 *  - This is a CODE-LEVEL set (single source of truth), applied by ELG-01 at
 *    evaluation time via `universalRulesForOpportunity()` — NOT materialized as
 *    a row on all ~600 opportunities. (A future task may materialize them if a
 *    query surface needs it; the model_inferred=false convention already keeps
 *    them safe from the extraction replace.)
 *
 * R8.4 STILL HOLDS: these rules are authoritative-source-CITED but still
 * agent-curated, not human-reviewed. So ELG-01 must NOT let them drive an
 * `excluded` bucket until a human promotes them (see `ELG01_UNIVERSAL_CONTRACT`).
 * Registration is a CONDITIONAL gate (a step with lead time), never an exclusion.
 */

/**
 * Which opportunities a universal rule applies to. Scopes are `kind`-aware so the
 * overlay handles the full instrument spread (grants, R&D, assistance, loans,
 * scholarships, procurement), not just grants:
 *  - `all`                  — every opportunity, regardless of kind.
 *  - `financial_assistance` — grant/rd/assistance/loan/scholarship (the federal
 *                             financial-assistance instruments governed by 2 CFR),
 *                             AND opportunities whose kind is unknown (back-compat:
 *                             the v1 corpus is grants and legacy callers pass only
 *                             title/program). NOT procurement — contracts are
 *                             governed by the FAR, which carries its own SAM rule.
 *  - `sbir_sttr`            — SBIR/STTR programs (detected from title/program).
 *  - `procurement`          — federal contract opportunities (kind `procurement`).
 *  - `loan`                 — repayable-capital programs (kind `loan`).
 *  - `scholarship`          — individual educational awards (kind `scholarship`).
 */
export const UniversalApplicabilitySchema = z.enum([
  "all",
  "financial_assistance",
  "sbir_sttr",
  "procurement",
  "loan",
  "scholarship",
]);
export type UniversalApplicability = z.infer<typeof UniversalApplicabilitySchema>;

/**
 * Instrument kinds that ARE federal financial assistance (2 CFR world), for the
 * `financial_assistance` scope. Procurement (a FAR contract) is deliberately
 * excluded — it gets the FAR-cited SAM rule instead of the 2 CFR one.
 */
const FINANCIAL_ASSISTANCE_KINDS: ReadonlySet<OpportunityKind> = new Set<OpportunityKind>([
  "grant",
  "rd",
  "assistance",
  "loan",
  "scholarship",
]);

/**
 * How ELG-01 renders the gate:
 *  - `conditional` → if unmet, the opportunity is `conditionally_eligible` with a
 *    concrete step + lead time (register in SAM.gov). NEVER an exclusion.
 *  - `categorical`  → a hard eligibility fact (SBIR size/ownership). Informs
 *    eligibility, but per R8.4 may not drive `excluded` until human review.
 */
export const UniversalGateKindSchema = z.enum(["conditional", "categorical"]);
export type UniversalGateKind = z.infer<typeof UniversalGateKindSchema>;

export const UniversalRuleSchema = z.object({
  id: z.string(),
  category: EligibilityRuleCategorySchema,
  description: z.string().min(1),
  /** MUST carry a source_url + verbatim quote from the controlling regulation. */
  citation: CitedCitationSchema,
  provenance: z.literal("authoritative").default("authoritative"),
  model_inferred: z.literal(false).default(false),
  applies_to: UniversalApplicabilitySchema,
  gate_kind: UniversalGateKindSchema,
  /** If unmet: the concrete next step + its typical lead time (for `conditional`). */
  remediation: z.string().optional(),
  lead_time: z.string().optional(),
});
export type UniversalRule = z.infer<typeof UniversalRuleSchema>;

/**
 * The curated universal overlay. Every quote is verbatim from the cited CFR
 * section (confirmed against Cornell LII / eCFR). No unverified clause is
 * asserted (e.g. the SBIR "organized for profit" clause is intentionally omitted
 * here because it was not confirmed verbatim — §11).
 */
export const UNIVERSAL_RULES: UniversalRule[] = UniversalRuleSchema.array().parse([
  {
    id: "universal-sam-registration",
    category: "registration",
    description:
      "Applicants must have an active SAM.gov registration and a Unique Entity Identifier (UEI) before submitting a federal financial-assistance application.",
    citation: {
      source_url: "https://www.law.cornell.edu/cfr/text/2/25.200",
      source_name: "2 CFR 25.200",
      quote: "Be registered in SAM.gov before submitting an application",
    },
    // Financial assistance (grants/R&D/assistance/loans/scholarships) + unknown
    // kind (back-compat). Procurement is covered separately by the FAR rule below.
    applies_to: "financial_assistance",
    gate_kind: "conditional",
    remediation:
      "Register the entity in SAM.gov and obtain a UEI before the application deadline.",
    lead_time: "SAM.gov registration commonly takes several weeks — start well before a deadline.",
  },
  {
    id: "universal-procurement-registration",
    category: "registration",
    description:
      "Federal procurement (contracts): an offeror must be registered in SAM.gov to submit an offer or quotation and at time of award.",
    citation: {
      source_url: "https://www.law.cornell.edu/cfr/text/48/52.204-7",
      source_name: "FAR 52.204-7(b)(1) (48 CFR 52.204-7)",
      quote:
        "An Offeror is required to be registered in SAM when submitting an offer or quotation and at time of award",
    },
    applies_to: "procurement",
    gate_kind: "conditional",
    remediation:
      "Register the entity in SAM.gov and obtain a UEI before submitting an offer or quotation.",
    lead_time: "SAM.gov registration commonly takes several weeks — start well before a solicitation closes.",
  },
  {
    id: "universal-loan-for-profit",
    category: "entity_type",
    description:
      "SBA business loans: the applicant must be an operating business organized for profit and located in the United States.",
    citation: {
      source_url: "https://www.law.cornell.edu/cfr/text/13/120.100",
      source_name: "13 CFR 120.100",
      quote: "Be organized for profit",
    },
    applies_to: "loan",
    gate_kind: "categorical",
  },
  {
    id: "universal-scholarship-individual",
    category: "entity_type",
    description:
      "Scholarships/fellowships are awarded to individuals — the applicant must be an individual, not an organization.",
    citation: {
      source_url: "https://www.law.cornell.edu/cfr/text/34/75.62",
      source_name: "34 CFR 75.62(a)",
      quote:
        "An entity that provides a fellowship, scholarship, or discretionary grant to an individual",
    },
    applies_to: "scholarship",
    gate_kind: "categorical",
  },
  {
    id: "universal-sbir-ownership",
    category: "size_ownership",
    description:
      "SBIR/STTR: the concern must be more than 50% owned and controlled by U.S. citizens or permanent resident aliens.",
    citation: {
      source_url: "https://www.law.cornell.edu/cfr/text/13/121.702",
      source_name: "13 CFR 121.702(a)(1)(i)",
      quote:
        "more than 50 percent directly owned and controlled by one or more individuals (who are citizens or permanent resident aliens of the United States)",
    },
    applies_to: "sbir_sttr",
    gate_kind: "categorical",
  },
  {
    id: "universal-sbir-size",
    category: "size_ownership",
    description:
      "SBIR/STTR: the awardee, together with its affiliates, must not have more than 500 employees.",
    citation: {
      source_url: "https://www.law.cornell.edu/cfr/text/13/121.702",
      source_name: "13 CFR 121.702(c)",
      quote:
        "An SBIR or STTR awardee, together with its affiliates, must not have more than 500 employees.",
    },
    applies_to: "sbir_sttr",
    gate_kind: "categorical",
  },
]);

/** Contract surfaced to ELG-01 (machine-readable R8.4 for the universal overlay). */
export const ELG01_UNIVERSAL_CONTRACT = {
  /** Universal rules are authoritative-cited but agent-curated → not human-reviewed. */
  provenance: "authoritative" as const,
  /** A universal rule may NOT drive an `excluded` bucket until human review (R8.4). */
  universal_rules_must_not_gate_exclusion_until_reviewed: true,
  /** `conditional` gates (registration) render as `conditionally_eligible` + a step. */
  conditional_gates_render_as_conditional: true,
} as const;

/** Case-insensitive detection of an SBIR/STTR opportunity from its title/program. */
export function isSbirSttr(opp: Pick<CanonOpportunity, "title" | "program">): boolean {
  const hay = `${opp.title ?? ""} ${opp.program ?? ""}`.toLowerCase();
  return /\bsbir\b|\bsttr\b|small business (innovation|technology transfer)/.test(hay);
}

/** All universal rules (the full curated overlay). */
export function getUniversalRules(): UniversalRule[] {
  return UNIVERSAL_RULES;
}

/** The opportunity shape the overlay reads: title/program for SBIR detection + kind. */
export type UniversalRuleOpportunity = Pick<CanonOpportunity, "title" | "program"> & {
  /** Instrument kind. Optional so legacy callers (title/program only) still work. */
  kind?: OpportunityKind;
  /**
   * Optional so legacy callers (title/program/kind only) still work — but
   * when present, gates EVERY rule in this file, regardless of `applies_to`.
   * This whole module is a FEDERAL regulatory overlay (2 CFR, the FAR, 13
   * CFR, 34 CFR); a state program (ca-grants/il-grants/nc-grants) must never
   * be told to register in SAM.gov, be "organized for profit" per SBA rules,
   * etc. — those gates are categorically inapplicable, not just unlikely.
   * See FEDERAL_SOURCES's own doc comment for why this is a real, previously
   * reported bug, not a hypothetical.
   */
  source?: OpportunitySource;
};

/** Whether a single universal rule applies to `opp`, honoring its `applies_to` scope. */
function ruleAppliesToOpportunity(rule: UniversalRule, opp: UniversalRuleOpportunity): boolean {
  // A known non-federal source (currently: ca-grants/il-grants/nc-grants)
  // never gets ANY universal rule here, regardless of kind — see
  // UniversalRuleOpportunity's `source` field doc above. Legacy callers that
  // don't pass `source` at all keep their pre-existing behavior unchanged.
  if (opp.source !== undefined && !FEDERAL_SOURCES.has(opp.source)) return false;

  switch (rule.applies_to) {
    case "all":
      return true;
    case "sbir_sttr":
      return isSbirSttr(opp);
    case "financial_assistance":
      // Unknown kind → treat as financial assistance (the v1 corpus is grants and
      // legacy callers pass only title/program). This preserves the pre-kind
      // behavior where the SAM.gov gate applied to every screened opportunity.
      return opp.kind === undefined || FINANCIAL_ASSISTANCE_KINDS.has(opp.kind);
    case "procurement":
      return opp.kind === "procurement";
    case "loan":
      return opp.kind === "loan";
    case "scholarship":
      return opp.kind === "scholarship";
  }
}

/**
 * The universal rules that apply to a given opportunity. Kind-aware:
 *  - financial assistance (grant/rd/assistance/loan/scholarship, or unknown kind)
 *    → the 2 CFR SAM.gov registration gate;
 *  - procurement → the FAR SAM.gov registration gate;
 *  - loan → the SBA "organized for profit" entity gate (13 CFR 120.100);
 *  - scholarship → the "awarded to individuals" entity gate (34 CFR 75.62);
 *  - SBIR/STTR (by title/program) → the size + ownership gates.
 * ELG-01 evaluates these alongside the per-opportunity `model_inferred` rules. Per
 * R8.4 the categorical kind gates are authoritative-cited but UNREVIEWED, so an
 * apparent mismatch renders `unknown` (needs review), never `excluded`.
 */
export function universalRulesForOpportunity(opp: UniversalRuleOpportunity): UniversalRule[] {
  return UNIVERSAL_RULES.filter((r) => ruleAppliesToOpportunity(r, opp));
}
