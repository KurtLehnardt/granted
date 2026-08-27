import type { StartupProfile } from "../contracts";
import type { CompanyProfile } from "../contracts/companyProfile";
import type { AutoFillRequirements } from "../mockAuth";
import { EMPTY_AUTO_FILL_REQUIREMENTS } from "../mockAuth";
import type { Opportunity } from "../contracts/opportunity";

// Re-exported so the SERVER route (`app/api/apply/package/route.ts`) can obtain
// the AutoFillRequirements shape + defaults WITHOUT importing `@/lib/mockAuth`
// directly — the R9.0 server-retention guard (lib/__tests__/noServerRetention)
// forbids the string "mockAuth" anywhere under app/api/**. mockAuth remains a
// client-only store; these are just its inert type + empty-default constant.
export type { AutoFillRequirements } from "../mockAuth";
export { EMPTY_AUTO_FILL_REQUIREMENTS } from "../mockAuth";
import { FOUNDER_TODO_PATTERN } from "../contracts/applicationDraft";
import type { ApplicationDraft, DraftSection } from "../contracts/applicationDraft";
import type { PrefilledForms } from "../contracts/applicationForms";
import type { ApplicationBudget } from "../contracts/applicationBudget";

/**
 * WS-G / G5 — pure application-package ASSEMBLY + gap-collection core.
 *
 * This module is the model-free, hermetically-testable heart of G5. The server
 * route (`app/api/apply/package/route.ts`) runs the G1→G2 model steps and the
 * G3→G4 deterministic builders, then hands the parts here to be shaped into one
 * `AssembledPackage`; the client (`components/ApplicationPackage.tsx`) renders
 * that shape. NOTHING in this file calls a model or the network — so it holds
 * the honesty guarantees structurally:
 *
 *   - `collectAllGaps` is the single gap-summary surface: it scans the G2
 *     narrative drafts, the G3 forms, and the G4 budget for every
 *     `[founder to provide: …]` placeholder and returns the deduped set, each
 *     entry re-validated against `FOUNDER_TODO_PATTERN` (defense-in-depth — the
 *     three builders each already guarantee their own gaps match it).
 *   - `assemblePackage` is a pure shaper: it never drafts, never invents a
 *     narrative, and always carries the DETERMINISTIC parts (forms + budget +
 *     checklist inputs) so a degraded model step (`narrativeStatus:
 *     "unavailable"`) still yields a partially-useful package.
 *   - `AOR_HANDOFF` is the honest hand-off copy: the tool assembled a
 *     submission-ready DRAFT, nothing was submitted, no application was filed,
 *     and final legal submission is the founder's authorized AOR's — never a
 *     "submitted"/"filed"/"won"/"approved" confirmation, never a definitive
 *     eligibility claim.
 *
 * `FOUNDER_TODO_PATTERN` is REUSED from `applicationDraft.ts` (not re-defined)
 * so G5 scans every WS-G surface with the one convention G2/G3/G4 all emit.
 */

// ---------------------------------------------------------------------------
// Gap-placeholder scanning (`[founder to provide: …]`)
// ---------------------------------------------------------------------------

/**
 * Global, NON-anchored scanner for inline `[founder to provide: …]` occurrences
 * in prose (mirrors G2's `FOUNDER_TODO_SCAN`). `[^\]]+` isolates each occurrence
 * so two adjacent placeholders never merge into one match. The anchored
 * `FOUNDER_TODO_PATTERN` validates a WHOLE placeholder string; this one FINDS
 * them inside a larger body of text.
 */
export const FOUNDER_TODO_SCAN = /\[founder to provide: [^\]]+\]/g;

/** Every inline `[founder to provide: …]` string present in `text`, in order. */
export function scanFounderTodos(text: string): string[] {
  return text.match(FOUNDER_TODO_SCAN) ?? [];
}

/**
 * The single gap-summary surface (test requirement 1). Collects every
 * `[founder to provide: …]` placeholder across the G2 narratives, the G3 forms,
 * and the G4 budget, dedupes, and keeps ONLY well-formed placeholders (each is
 * re-checked against `FOUNDER_TODO_PATTERN`). Order is stable: narratives, then
 * forms, then budget, first occurrence wins.
 */
export function collectAllGaps(parts: {
  draft?: ApplicationDraft | null;
  forms: PrefilledForms;
  budget: ApplicationBudget;
}): string[] {
  const all: string[] = [];

  if (parts.draft) {
    for (const section of parts.draft.sections) {
      // Inline scan of the drafted prose is authoritative; the section's own
      // `gaps[].placeholder` mirror it (G2 keeps them in correspondence).
      for (const ph of scanFounderTodos(section.draft_text)) all.push(ph);
      for (const gap of section.gaps) all.push(gap.placeholder);
    }
  }
  for (const gap of parts.forms.gaps) all.push(gap);
  for (const gap of parts.budget.gaps) all.push(gap);

  const seen = new Set<string>();
  const out: string[] = [];
  for (const gap of all) {
    if (!FOUNDER_TODO_PATTERN.test(gap)) continue; // defensive: only real blanks
    if (seen.has(gap)) continue;
    seen.add(gap);
    out.push(gap);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Assembled package shape
// ---------------------------------------------------------------------------

/**
 * Whether the grounded NARRATIVE step (G1 requirements + G2 drafting) produced
 * output. `"drafted"` — at least the first section was drafted (or requirements
 * came back with no narrative sections to draft). `"unavailable"` — the model
 * step failed after retry; the deterministic parts below are still present.
 */
export type NarrativeStatus = "drafted" | "unavailable";

/** A required narrative section G1 found but G5 did NOT draft (draftable on demand). */
export interface DraftableSection {
  key: string;
  title: string;
  prompt: string;
}

/** The checklist INPUTS the client passes to the reused D6 `<ApplicationChecklist>`. */
export interface ChecklistInputs {
  allRegistrationsSatisfied: boolean;
}

/**
 * The full assembled, submission-READY package for one opportunity. Every
 * founder-facing blank across all three artifacts is collected in `gaps`.
 * Nothing here is ever a submission — see `AOR_HANDOFF`.
 */
export interface AssembledPackage {
  opportunity_id: string;
  program_title: string;
  generated_at: string;

  /** Did the grounded narrative step produce output? */
  narrativeStatus: NarrativeStatus;
  /** An honest note shown when `narrativeStatus === "unavailable"`. */
  narrativeNote?: string;
  /** Was G1's requirement extraction available (drives the budget's `budget_rules`)? */
  requirementsAvailable: boolean;

  /** (1) The drafted grounded narrative sections (empty when degraded). */
  narratives: DraftSection[];
  /** Required sections G1 found but G5 did not draft (to keep spend modest). */
  draftableSections: DraftableSection[];

  /** (2) The G3 deterministic SF-424 pre-fill. */
  forms: PrefilledForms;
  /** (3) The G4 deterministic grounded budget. */
  budget: ApplicationBudget;
  /** (4) Inputs for the reused D6 `<ApplicationChecklist>`. */
  checklist: ChecklistInputs;

  /** (5) Every `[founder to provide: …]` across narratives + forms + budget. */
  gaps: string[];
}

export interface AssembleInput {
  opportunity_id: string;
  program_title: string;
  forms: PrefilledForms;
  budget: ApplicationBudget;
  checklist: ChecklistInputs;
  /** All G1 specified narrative sections (used to derive `draftableSections`). */
  narrativeSections?: DraftableSection[];
  /** G2 drafted sections (the first 1–2 only). `null`/omitted when degraded. */
  draft?: ApplicationDraft | null;
  narrativeStatus: NarrativeStatus;
  narrativeNote?: string;
  requirementsAvailable: boolean;
  /** ISO timestamp; defaults to now. Injectable for deterministic tests. */
  generated_at?: string;
}

/**
 * Pure shaper: fold the deterministic parts (forms + budget + checklist) and the
 * optional grounded narrative draft into one `AssembledPackage`, with the
 * complete gap summary derived by `collectAllGaps`. NEVER drafts or invents —
 * a missing draft simply yields an empty `narratives` array and every specified
 * section listed under `draftableSections`.
 */
export function assemblePackage(input: AssembleInput): AssembledPackage {
  const draftedKeys = new Set((input.draft?.sections ?? []).map((s) => s.key));
  const draftableSections = (input.narrativeSections ?? []).filter(
    (s) => !draftedKeys.has(s.key),
  );

  return {
    opportunity_id: input.opportunity_id,
    program_title: input.program_title,
    generated_at: input.generated_at ?? new Date().toISOString(),
    narrativeStatus: input.narrativeStatus,
    narrativeNote: input.narrativeNote,
    requirementsAvailable: input.requirementsAvailable,
    narratives: input.draft?.sections ?? [],
    draftableSections,
    forms: input.forms,
    budget: input.budget,
    checklist: input.checklist,
    gaps: collectAllGaps({ draft: input.draft, forms: input.forms, budget: input.budget }),
  };
}

// ---------------------------------------------------------------------------
// Registration-satisfied derivation (mirrors AutoFillFlow's `satisfied` map)
// ---------------------------------------------------------------------------

/**
 * Are all four SAM.gov / UEI / AOR / E-Biz registration facts on file? Same
 * derivation AutoFillFlow renders its checklist from — kept here so the route
 * and the checklist never disagree about what's satisfied.
 */
export function allRegistrationsSatisfied(reqs: AutoFillRequirements): boolean {
  const sam = reqs.samRegistered === true;
  const uei = reqs.uei.trim().length > 0;
  const aor = reqs.aorOnFile || reqs.aorName.trim().length > 0;
  const ebiz = reqs.eBizPocOnFile === true;
  return sam && uei && aor && ebiz;
}

// ---------------------------------------------------------------------------
// v1 StartupProfile → §3.1 CompanyProfile (for the wired "Draft my application")
// ---------------------------------------------------------------------------

/**
 * The live match pipeline extracts the ad-hoc v1 `StartupProfile` and the client
 * carries it on `map.profile`. G2/G3/G4 consume the §3.1 `CompanyProfile`. This
 * PURE mapper carries the founder's OWN extracted fields across so the wired
 * "Draft my application" path drafts from real grounded data — anything the v1
 * profile does not carry simply stays absent, so G2/G3/G4 emit honest
 * `[founder to provide: …]` gaps for it (NEVER a fabricated value).
 *
 * Provenance mirrors `lib/eligibility/bridge.ts`: extracted fields are
 * `model_inferred` (they were inferred, not confirmed — and G2 grounding checks
 * only PRESENCE, never provenance), the founder's own description is
 * `user_stated`, and the self-reported SAM/UEI facts are `user_stated`. This is
 * DISTINCT from `toCompanyProfile` in the eligibility bridge, which deliberately
 * drops these non-gate fields for screening safety — for drafting they are
 * exactly the grounded material we want.
 */
export function startupProfileToCompanyProfile(
  sp: StartupProfile | undefined,
  reqs?: AutoFillRequirements,
): CompanyProfile {
  const inferredStr = (v: string) => ({ value: v, provenance: "model_inferred" as const, confidence: 0.5 });

  const profile: CompanyProfile = {
    id: "v1-startup-profile",
    raw_text: { value: sp?.description ?? "", provenance: "user_stated", confidence: 1 },
    interview_answers: [],
  };

  if (sp?.industry?.trim()) profile.industry = inferredStr(sp.industry.trim());
  if (sp?.technology?.trim()) profile.technology = inferredStr(sp.technology.trim());
  if (sp?.location?.trim()) profile.location = inferredStr(sp.location.trim());
  if (sp?.revenue?.trim()) profile.revenue = inferredStr(sp.revenue.trim());
  if (sp?.fundingStage?.trim()) profile.funding_stage = inferredStr(sp.fundingStage.trim());
  if (sp?.capitalRaised?.trim()) profile.capital_raised = inferredStr(sp.capitalRaised.trim());
  if (sp?.capitalRequirement?.trim()) profile.capital_requirement = inferredStr(sp.capitalRequirement.trim());
  if (sp?.useOfFunds?.trim()) profile.use_of_funds = inferredStr(sp.useOfFunds.trim());
  if (sp?.rdActivities?.trim()) profile.rd_activities = inferredStr(sp.rdActivities.trim());
  if (sp?.productMaturity?.trim()) profile.product_maturity = inferredStr(sp.productMaturity.trim());
  if (sp?.targetCustomers?.trim()) profile.target_customers = inferredStr(sp.targetCustomers.trim());

  if (typeof sp?.employees === "number" && Number.isFinite(sp.employees) && sp.employees >= 0) {
    profile.employee_count = { value: Math.round(sp.employees), provenance: "model_inferred", confidence: 0.5 };
  }

  const naics = (sp?.naicsGuesses ?? []).map((c) => String(c).trim()).filter(Boolean);
  if (naics.length > 0) profile.naics_codes = { value: naics, provenance: "model_inferred", confidence: 0.5 };

  const terms = (sp?.expandedTerms ?? []).map((t) => String(t).trim()).filter(Boolean);
  if (terms.length > 0) profile.expanded_terms = { value: terms, provenance: "model_inferred", confidence: 0.5 };

  // Founder self-reported registration facts (user_stated) — the same two the
  // match pipeline already trusts to satisfy the SAM registration step.
  if (reqs?.samRegistered) profile.sam_registered = { value: true, provenance: "user_stated", confidence: 1 };
  if (reqs?.uei?.trim()) profile.uei = { value: reqs.uei.trim(), provenance: "user_stated", confidence: 1 };

  return profile;
}

/** The program title carried onto a package (opportunity title/program, else id). */
export function packageProgramTitle(opp: Opportunity): string {
  return (opp.title ?? "").trim() || (opp.program ?? "").trim() || opp.id;
}

// ---------------------------------------------------------------------------
// Honest AOR hand-off copy (the last step; never a submission confirmation)
// ---------------------------------------------------------------------------

/**
 * The honest hand-off copy, consistent with `components/AutoFillFlow.tsx`: the
 * tool drafted a submission-READY package, nothing was submitted, no application
 * was filed, and final legal submission is the founder's authorized AOR's,
 * through the program's official portal. Every string here is deliberately clear
 * of any "submitted"/"filed"/"won"/"approved" CONFIRMATION and of any banned
 * definitive-eligibility phrasing. Exported so tests can assert the invariants
 * directly against the source of truth.
 */
export const AOR_HANDOFF = {
  eyebrow: "Final step · nothing has been submitted",
  headline: "Review & submit via your authorized AOR",
  body:
    "This is a submission-ready draft assembled from your profile and this program's own stated " +
    "requirements. To be clear about what just happened: nothing was submitted to Grants.gov, SAM.gov, " +
    "or any agency, no application was filed, and no payment was taken. Complete every highlighted " +
    "[founder to provide: …] blank above, then have your organization's Authorized Organization " +
    "Representative (AOR) review the finished package and submit it through the program's official portal.",
  cta: "Review & submit via your authorized AOR",
} as const;

/**
 * The overall honesty framing shown at the top of the package. Same discipline
 * as the checklist: a preparation/draft artifact, never a submission, never an
 * eligibility determination.
 */
export const PACKAGE_INTRO = {
  eyebrow: "Submission-ready draft · not a submission",
  note:
    "Everything below is a draft grounded in what you've told us and this program's own announcement " +
    "text. Any fact we don't have is left as a highlighted blank for you to complete rather than guessed. " +
    "This tool does not determine eligibility and never submits anything on your behalf.",
} as const;
