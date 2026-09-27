import type { DraftSection } from "./applicationDraft";
import type { PrefilledForms } from "./applicationForms";
import type { ApplicationBudget } from "./applicationBudget";

/**
 * VENDORED SUBSET of `scaffold/lib/apply/package.ts` — the `AssembledPackage`
 * type + honest hand-off copy (`AOR_HANDOFF`, `PACKAGE_INTRO`) ONLY. The
 * extension never assembles a package (that is exclusively the app's job); it
 * only ever CONSUMES an already-assembled, already-validated package as
 * inert data (INV-8). The assembly functions (`assemblePackage`,
 * `collectAllGaps`, `startupProfileToCompanyProfile`, …) are therefore
 * deliberately NOT vendored — only the shape and the honest copy the popup
 * must mirror (spec §5, §5.3, INV-12).
 *
 * Kept byte-for-byte equivalent for the parts vendored (see
 * `test/contractDrift.test.ts`).
 *
 * WS-G / G5 — pure application-package ASSEMBLY + gap-collection core.
 *
 *   - `AOR_HANDOFF` is the honest hand-off copy: the tool assembled a
 *     submission-ready DRAFT, nothing was submitted, no application was filed,
 *     and final legal submission is the user's authorized AOR's — never a
 *     "submitted"/"filed"/"won"/"approved" confirmation, never a definitive
 *     eligibility claim.
 */

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
 * user-facing blank across all three artifacts is collected in `gaps`.
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

  /** (5) Every `[you to provide: …]` across narratives + forms + budget. */
  gaps: string[];
}

// ---------------------------------------------------------------------------
// Honest AOR hand-off copy (the last step; never a submission confirmation)
// ---------------------------------------------------------------------------

/**
 * The honest hand-off copy, consistent with `components/AutoApplyFlow.tsx`: the
 * tool drafted a submission-READY package, nothing was submitted, no application
 * was filed, and final legal submission is the user's authorized AOR's,
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
    "[you to provide: …] blank above, then have your organization's Authorized Organization " +
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
    "text. Any fact we don't have is left as a blank for you to fill in, never guessed. " +
    "This tool does not determine eligibility and never submits anything on your behalf.",
} as const;
