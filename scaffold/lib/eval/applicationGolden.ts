import type { CompanyProfile } from "../contracts/companyProfile";
import type { AutoFillRequirements } from "../mockAuth";
import { EMPTY_AUTO_FILL_REQUIREMENTS } from "../mockAuth";
import type { Opportunity } from "../contracts/opportunity";
import type { NarrativeSection } from "../contracts/applicationRequirements";

/**
 * G7 — golden application-eval cases for the WS-G anti-fabrication / honesty
 * invariants (see `lib/eval/__tests__/applicationHonesty.test.ts`).
 *
 * WHAT THIS FILE IS: static, hermetic fixtures ONLY — no network, no model
 * call. Each case pairs a founder `CompanyProfile` (real, varying levels of
 * completeness) + a matched `Opportunity` + the G1 `narrativeSections` a real
 * `extractApplicationRequirements` call would have produced, WITH a
 * `rawSections` array that stands in for the raw G2 `draftOneSection` model
 * output BEFORE `enforceGrounding`/`validateDraftGrounding` ever see it —
 * i.e. exactly the shape `normalizeRawSection` in `lib/apply/draft.ts` hands
 * to grounding enforcement. The test suite feeds `rawSections` through the
 * REAL, unmodified `enforceGrounding` + `validateDraftGrounding` +
 * `ApplicationDraftSchema.parse` from `lib/apply/draft.ts`, and the REAL
 * `prefillApplicationForms` / `buildBudget` / `assemblePackage` from
 * `lib/apply/forms.ts` / `lib/apply/budget.ts` / `lib/apply/package.ts` — this
 * is the deterministic assembly path the task calls for; nothing here is
 * exercised in isolation from the actual apply engine.
 *
 * `rawSections` are DELIBERATELY adversarial in places: some entries carry a
 * model "claim" that cites a profile field the founder never provided (the
 * textbook fabrication-risk case `validateDraftGrounding` clause (a) exists to
 * catch), and the SPARSE case additionally carries an "unclaimed" fabricated
 * sentence — specific, invented numbers written directly into `draft_text`
 * with NO corresponding `claims` entry at all. That second shape is not
 * hypothetical paranoia: the drafting prompt (`DRAFT_APPLICATION_SECTION_V1_TEMPLATE`
 * in `lib/prompts/registry.ts`) instructs the model to list every factual
 * sentence in `claims`, but nothing in `lib/apply/draft.ts` cross-checks
 * `draft_text` for factual-sounding sentences the model simply forgot (or
 * chose) not to declare. See the `// KNOWN FINDING:` comment on the
 * corresponding test in `applicationHonesty.test.ts` for the full writeup —
 * this fixture is what proves it.
 */

/** A `user_stated` provenanced cell (the founder typed/selected it themselves). */
function stated<T>(value: T) {
  return { value, provenance: "user_stated" as const, confidence: 1 };
}

// ---------------------------------------------------------------------------
// Raw (pre-enforcement) model-output shape — mirrors `RawSection` /
// `normalizeRawSection`'s output in `lib/apply/draft.ts` closely enough to
// feed straight into `enforceGrounding`/`validateDraftGrounding` as a
// `DraftSection` (the two extra fields, `key`/`title`/`prompt`, are carried
// from the matching `NarrativeSection`).
// ---------------------------------------------------------------------------

export interface GoldenRawClaim {
  text: string;
  profile_field: string;
}

export interface GoldenRawGap {
  field_hint: string;
  placeholder: string;
}

export interface GoldenRawSection {
  key: string;
  title: string;
  prompt: string;
  draft_text: string;
  claims: GoldenRawClaim[];
  gaps: GoldenRawGap[];
}

export interface ApplicationGoldenCase {
  id: string;
  label: string;
  /** Short description of what this case is proving. */
  description: string;
  profile: CompanyProfile;
  reqs: AutoFillRequirements;
  opportunity: Opportunity;
  /** The G1 `ApplicationRequirements.narrative_sections` a real extraction would have produced (all `specified: true`). */
  narrativeSections: NarrativeSection[];
  /**
   * Simulated RAW G2 model output for the (1-2) sections actually drafted —
   * pre-`enforceGrounding`. Sections in `narrativeSections` with no matching
   * entry here are exercising the "not drafted, listed as draftable" path
   * `assemblePackage` handles (mirrors G2's real "keep spend modest" behavior
   * of drafting only the first section or two).
   */
  rawSections: GoldenRawSection[];
  /** True when at least one `rawSections` claim cites a field NOT actually provided (the fabrication-risk case grounding enforcement must neutralize). */
  hasDeclaredFabricationRisk: boolean;
  /** True when `rawSections` carries a factual-sounding sentence with NO corresponding `claims` entry (the KNOWN FINDING case — see file header). */
  hasUndeclaredFabrication: boolean;
}

// ---------------------------------------------------------------------------
// Case 1 — SPARSE profile. Only two fields provided. Forces many
// `[founder to provide: …]` gaps across narrative + forms + budget, AND
// carries both a declared fabrication risk (caught) and an undeclared one
// (the known finding).
// ---------------------------------------------------------------------------

const SPARSE_PROFILE: CompanyProfile = {
  id: "golden-sparse",
  raw_text: stated("We are building sensors for clinics."),
  industry: stated("medical diagnostics"),
  interview_answers: [],
};

const SPARSE_OPPORTUNITY: Opportunity = {
  id: "opp-sparse-1",
  source: "grants.gov",
  kind: "grant",
  program: "Rural Health Innovation Grant",
  title: "Rural Health Innovation Grant Program",
  agency: "Department of Health and Human Services",
  description: "Grant supporting early-stage health technology for underserved rural communities.",
  source_id: "HHS-RHI-2026-014",
};

const SPARSE_NARRATIVE_SECTIONS: NarrativeSection[] = [
  {
    key: "project_summary",
    title: "Project Summary",
    prompt: "Describe your company and the project this grant would fund.",
    source_quote: "Applicants must submit a project summary describing the proposed work.",
    specified: true,
  },
  {
    key: "traction_and_impact",
    title: "Traction & Impact",
    prompt: "Describe your traction to date and the impact this project will have.",
    source_quote: "Describe evidence of traction and anticipated impact.",
    specified: true,
  },
  {
    key: "budget_narrative",
    title: "Budget Narrative",
    prompt: "Justify your proposed budget.",
    source_quote: "Include a budget narrative justifying requested costs.",
    specified: true,
  },
];

/**
 * Sparse case, section 1: honest — grounds in `industry` (provided), gaps
 * everything else inline. This is the CLEAN path working correctly.
 */
const SPARSE_SECTION_SUMMARY: GoldenRawSection = {
  key: "project_summary",
  title: "Project Summary",
  prompt: "Describe your company and the project this grant would fund.",
  draft_text:
    "We work in medical diagnostics. Our core technology is [founder to provide: core technology]. " +
    "We are based in [founder to provide: primary location].",
  claims: [{ text: "We work in medical diagnostics.", profile_field: "industry" }],
  gaps: [
    { field_hint: "core technology", placeholder: "[founder to provide: core technology]" },
    { field_hint: "primary location", placeholder: "[founder to provide: primary location]" },
  ],
};

/**
 * Sparse case, section 2: ADVERSARIAL. Two distinct fabrication shapes in one
 * section, on a profile that provides neither `revenue` nor any traction
 * field:
 *   1. A DECLARED fabrication — a `claims` entry citing `profile_field:
 *      "revenue"`, which `sampleProfile` never provides. This is the
 *      textbook case `validateDraftGrounding` clause (a) / `enforceGrounding`
 *      step 1 exist to catch, and the test asserts it IS caught and
 *      neutralized.
 *   2. An UNDECLARED fabrication — "Our platform now serves more than 3,000
 *      rural clinics nationwide." is a specific, invented metric with NO
 *      corresponding `claims` entry at all (the model simply never listed
 *      it). This is the KNOWN FINDING fixture — see the file header and the
 *      matching `// KNOWN FINDING:` test.
 */
const SPARSE_SECTION_TRACTION: GoldenRawSection = {
  key: "traction_and_impact",
  title: "Traction & Impact",
  prompt: "Describe your traction to date and the impact this project will have.",
  draft_text:
    "We generated $180,000 in revenue last quarter. " +
    "Our platform now serves more than 3,000 rural clinics nationwide. " +
    "This project will expand our reach to underserved communities.",
  claims: [
    // (1) declared fabrication risk — "revenue" is NOT provided on SPARSE_PROFILE.
    { text: "We generated $180,000 in revenue last quarter.", profile_field: "revenue" },
    // NOTE: deliberately NO claims entry for the "3,000 rural clinics" sentence.
  ],
  gaps: [],
};

export const SPARSE_CASE: ApplicationGoldenCase = {
  id: "sparse-founder",
  label: "Sparse founder profile (2 fields provided)",
  description:
    "Only raw_text + industry provided. Must force many [founder to provide] gaps across " +
    "narrative + forms + budget, and exercises both the caught (declared) and the known-finding " +
    "(undeclared) fabrication shapes.",
  profile: SPARSE_PROFILE,
  reqs: { ...EMPTY_AUTO_FILL_REQUIREMENTS },
  opportunity: SPARSE_OPPORTUNITY,
  narrativeSections: SPARSE_NARRATIVE_SECTIONS,
  rawSections: [SPARSE_SECTION_SUMMARY, SPARSE_SECTION_TRACTION],
  hasDeclaredFabricationRisk: true,
  hasUndeclaredFabrication: true,
};

// ---------------------------------------------------------------------------
// Case 2 — NO-TRACTION profile. Identity fields are provided (industry,
// technology, location, use_of_funds) but NO revenue / capital_raised /
// employee_count / funding_stage — i.e. no metrics to draw on at all. The
// raw draft tries (and must fail) to cite a metric anyway; unlike the sparse
// case, this fixture carries ONLY the declared-fabrication shape, to prove
// the primary defense (enforceGrounding neutralizing a declared claim) works
// cleanly on its own, isolated from the known finding.
// ---------------------------------------------------------------------------

const NO_TRACTION_PROFILE: CompanyProfile = {
  id: "golden-no-traction",
  raw_text: stated(
    "We build electrochemical biosensor arrays that give rural clinics same-day diagnostic results.",
  ),
  industry: stated("medical diagnostics"),
  technology: stated("electrochemical biosensor arrays"),
  location: stated("Boise, Idaho"),
  use_of_funds: stated("clinical validation studies and a first small-batch manufacturing line"),
  interview_answers: [],
};

const NO_TRACTION_OPPORTUNITY: Opportunity = {
  id: "opp-no-traction-1",
  source: "sbir",
  kind: "rd",
  program: "NIH SBIR Phase I — Diagnostics",
  title: "NIH SBIR Phase I: Point-of-Care Diagnostics",
  agency: "National Institutes of Health",
  description: "Phase I SBIR funding for early-stage point-of-care diagnostic technology.",
  source_id: "NIH-SBIR-2026-0231",
};

const NO_TRACTION_NARRATIVE_SECTIONS: NarrativeSection[] = [
  {
    key: "project_summary",
    title: "Project Summary",
    prompt: "Summarize the proposed R&D project.",
    source_quote: "Applicants must provide a project summary.",
    specified: true,
  },
  {
    key: "commercialization_plan",
    title: "Commercialization Plan",
    prompt: "Describe your commercialization plan and traction to date.",
    source_quote: "Describe the commercialization plan, including any market traction.",
    specified: true,
  },
];

/** Grounded correctly — every claim cites a field that IS provided. */
const NO_TRACTION_SECTION_SUMMARY: GoldenRawSection = {
  key: "project_summary",
  title: "Project Summary",
  prompt: "Summarize the proposed R&D project.",
  draft_text:
    "We build electrochemical biosensor arrays that give rural clinics same-day diagnostic results. " +
    "We are based in Boise, Idaho. This funding would go toward clinical validation studies and a first " +
    "small-batch manufacturing line.",
  claims: [
    {
      text: "We build electrochemical biosensor arrays that give rural clinics same-day diagnostic results.",
      profile_field: "technology",
    },
    { text: "We are based in Boise, Idaho.", profile_field: "location" },
    {
      text:
        "This funding would go toward clinical validation studies and a first small-batch " +
        "manufacturing line.",
      profile_field: "use_of_funds",
    },
  ],
  gaps: [],
};

/**
 * ADVERSARIAL but ONLY the declared shape: the model tries to cite
 * `profile_field: "revenue"` (not provided) for a plausible-sounding but
 * invented pilot-customer count, entirely inside `claims` — no undeclared
 * fabrication in this section. Proves the primary defense holds on its own.
 */
const NO_TRACTION_SECTION_COMMERCIALIZATION: GoldenRawSection = {
  key: "commercialization_plan",
  title: "Commercialization Plan",
  prompt: "Describe your commercialization plan and traction to date.",
  draft_text:
    "Our technology aligns with the program's stated priority of expanding rural diagnostic access. " +
    "We currently generate $95,000 in annual revenue from early pilot customers.",
  claims: [
    {
      text: "Our technology aligns with the program's stated priority of expanding rural diagnostic access.",
      profile_field: "technology",
    },
    // fabrication risk: "revenue" is NOT provided on NO_TRACTION_PROFILE.
    { text: "We currently generate $95,000 in annual revenue from early pilot customers.", profile_field: "revenue" },
  ],
  gaps: [],
};

export const NO_TRACTION_CASE: ApplicationGoldenCase = {
  id: "no-traction",
  label: "No traction/metrics profile (identity provided, no revenue/capital_raised)",
  description:
    "Identity fields provided; no revenue, capital_raised, or employee_count. The draft must not " +
    "invent any number. Carries ONLY the declared-fabrication shape (isolates the primary defense).",
  profile: NO_TRACTION_PROFILE,
  reqs: { ...EMPTY_AUTO_FILL_REQUIREMENTS },
  opportunity: NO_TRACTION_OPPORTUNITY,
  narrativeSections: NO_TRACTION_NARRATIVE_SECTIONS,
  rawSections: [NO_TRACTION_SECTION_SUMMARY, NO_TRACTION_SECTION_COMMERCIALIZATION],
  hasDeclaredFabricationRisk: true,
  hasUndeclaredFabrication: false,
};

// ---------------------------------------------------------------------------
// Case 3 — RICH profile. Many fields genuinely provided (including
// revenue/capital_raised/employee_count), plus SAM/UEI/AOR on file. Every
// claim below cites a field that really is provided — no fabrication needed,
// and no fabrication attempted. Used as the "fewer gaps" counterpart to the
// sparse case.
// ---------------------------------------------------------------------------

const RICH_PROFILE: CompanyProfile = {
  id: "golden-rich",
  raw_text: stated(
    "We build electrochemical biosensor arrays that give rural clinics same-day diagnostic results.",
  ),
  industry: stated("medical diagnostics"),
  technology: stated("electrochemical biosensor arrays"),
  location: stated("Boise, Idaho"),
  use_of_funds: stated("hiring two engineers, clinical validation, and manufacturing equipment"),
  entity_type: stated("for_profit_small_business"),
  employee_count: stated(9),
  funding_stage: stated("seed"),
  capital_raised: stated("250k_1m"),
  capital_requirement: stated("250k_1m"),
  revenue: stated("under_100k"),
  product_maturity: stated("beta"),
  target_customers: stated("rural community health clinics"),
  naics_codes: stated(["334516"]),
  sam_registered: stated(true),
  uei: stated("ABC123XYZ789"),
  interview_answers: [],
};

const RICH_OPPORTUNITY: Opportunity = {
  id: "opp-rich-1",
  source: "grants.gov",
  kind: "grant",
  program: "Advanced Diagnostics for Rural Health",
  title: "Advanced Diagnostics for Rural Health",
  agency: "Department of Health and Human Services",
  description: "Grant for advanced diagnostic technology serving rural health systems.",
  source_id: "HHS-2026-0088",
  award_range: { floor: 100_000, ceiling: 750_000, currency: "USD" },
};

const RICH_NARRATIVE_SECTIONS: NarrativeSection[] = [
  {
    key: "project_summary",
    title: "Project Summary",
    prompt: "Summarize your company and project.",
    source_quote: "Provide a project summary.",
    specified: true,
  },
  {
    key: "traction_and_impact",
    title: "Traction & Impact",
    prompt: "Describe your traction to date.",
    source_quote: "Describe traction and impact to date.",
    specified: true,
  },
];

const RICH_SECTION_SUMMARY: GoldenRawSection = {
  key: "project_summary",
  title: "Project Summary",
  prompt: "Summarize your company and project.",
  draft_text:
    "We build electrochemical biosensor arrays that give rural clinics same-day diagnostic results, " +
    "based in Boise, Idaho. We are a 9-person, seed-stage company. This funding would go toward hiring " +
    "two engineers, clinical validation, and manufacturing equipment.",
  claims: [
    {
      text:
        "We build electrochemical biosensor arrays that give rural clinics same-day diagnostic results, " +
        "based in Boise, Idaho.",
      profile_field: "technology",
    },
    { text: "We are a 9-person, seed-stage company.", profile_field: "employee_count" },
    {
      text: "This funding would go toward hiring two engineers, clinical validation, and manufacturing equipment.",
      profile_field: "use_of_funds",
    },
  ],
  gaps: [],
};

const RICH_SECTION_TRACTION: GoldenRawSection = {
  key: "traction_and_impact",
  title: "Traction & Impact",
  prompt: "Describe your traction to date.",
  draft_text:
    "We are already generating under $100K in annual revenue, serving rural community health clinics, " +
    "with our product currently in beta.",
  claims: [
    { text: "We are already generating under $100K in annual revenue", profile_field: "revenue" },
    { text: "serving rural community health clinics", profile_field: "target_customers" },
    { text: "with our product currently in beta", profile_field: "product_maturity" },
  ],
  gaps: [],
};

export const RICH_CASE: ApplicationGoldenCase = {
  id: "rich-founder",
  label: "Rich founder profile (many fields provided, including revenue/traction)",
  description:
    "Identity + traction + registration fields all genuinely provided. No fabrication attempted or " +
    "needed. Used as the low-gap counterpart to the sparse case.",
  profile: RICH_PROFILE,
  reqs: {
    samRegistered: true,
    samRegisteredDate: "2025-01-10",
    uei: "ABC123XYZ789",
    aorName: "Jordan Rivera",
    aorOnFile: true,
    eBizPocOnFile: true,
  },
  opportunity: RICH_OPPORTUNITY,
  narrativeSections: RICH_NARRATIVE_SECTIONS,
  rawSections: [RICH_SECTION_SUMMARY, RICH_SECTION_TRACTION],
  hasDeclaredFabricationRisk: false,
  hasUndeclaredFabrication: false,
};

// ---------------------------------------------------------------------------
// Case 4 — BANNED-PHRASE ATTEMPT. A raw model section that asserts
// eligibility outright. There is no honest placeholder for an eligibility
// assertion, so `enforceGrounding` must REFUSE (throw `DraftGroundingError`)
// rather than ship a hedged/neutralized guess. Proves invariant 2 (never
// claims submission/award/eligibility) holds even under an adversarial raw
// model output, not just on the hand-written honest copy.
// ---------------------------------------------------------------------------

const BANNED_PHRASE_PROFILE: CompanyProfile = {
  id: "golden-banned-phrase",
  raw_text: stated("We build electrochemical biosensor arrays for rural clinics."),
  technology: stated("electrochemical biosensor arrays"),
  interview_answers: [],
};

const BANNED_PHRASE_OPPORTUNITY: Opportunity = {
  id: "opp-banned-phrase-1",
  source: "grants.gov",
  kind: "grant",
  program: "Advanced Diagnostics Grant",
  title: "Advanced Diagnostics for Rural Health",
  agency: "Department of Health and Human Services",
  description: "Grant for advanced diagnostic technology.",
  source_id: "HHS-2026-0099",
};

const BANNED_PHRASE_NARRATIVE_SECTIONS: NarrativeSection[] = [
  {
    key: "project_summary",
    title: "Project Summary",
    prompt: "Summarize your project.",
    source_quote: "Provide a project summary.",
    specified: true,
  },
];

const BANNED_PHRASE_SECTION: GoldenRawSection = {
  key: "project_summary",
  title: "Project Summary",
  prompt: "Summarize your project.",
  draft_text:
    "We build electrochemical biosensor arrays for rural clinics, so you are eligible for this award.",
  claims: [
    {
      text: "We build electrochemical biosensor arrays for rural clinics",
      profile_field: "technology",
    },
  ],
  gaps: [],
};

export const BANNED_PHRASE_ATTEMPT_CASE: ApplicationGoldenCase = {
  id: "banned-phrase-attempt",
  label: "Adversarial raw draft asserting eligibility outright",
  description:
    "draft_text asserts eligibility ('you are eligible for this award'). enforceGrounding must throw " +
    "rather than ship it — there is no honest placeholder for a definitive eligibility/award claim.",
  profile: BANNED_PHRASE_PROFILE,
  reqs: { ...EMPTY_AUTO_FILL_REQUIREMENTS },
  opportunity: BANNED_PHRASE_OPPORTUNITY,
  narrativeSections: BANNED_PHRASE_NARRATIVE_SECTIONS,
  rawSections: [BANNED_PHRASE_SECTION],
  hasDeclaredFabricationRisk: false,
  hasUndeclaredFabrication: false,
};

// ---------------------------------------------------------------------------
// All cases (the eval suite iterates this set)
// ---------------------------------------------------------------------------

/** Cases that are expected to assemble into a valid package (excludes the refusal case). */
export const APPLICATION_GOLDEN_CASES: readonly ApplicationGoldenCase[] = [
  SPARSE_CASE,
  NO_TRACTION_CASE,
  RICH_CASE,
];
