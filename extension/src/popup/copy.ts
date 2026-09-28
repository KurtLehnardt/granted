import { AOR_HANDOFF, PACKAGE_INTRO } from "../lib/contracts/package";
import type { FillOutcome } from "../content/fillEngine";

/**
 * All popup/UI copy in one place (spec §5.3, INV-12). Honest by
 * construction: mirrors the register of `AOR_HANDOFF`/`PACKAGE_INTRO`
 * (imported directly from the vendored contract — not re-typed — so the
 * terminal panel is verbatim-identical to the app's own hand-off copy) and
 * is asserted, in `test/copyLint.test.ts`, to:
 *   - never contain a submit/eligibility CONFIRMATION (mirrors the scaffold's
 *     own `SUBMIT_CONFIRMATION_PATTERNS` discipline — see
 *     `scaffold/lib/apply/__tests__/package.test.ts`), and
 *   - never contain any of `findBannedPhrases`' definitive-eligibility phrases.
 */

export { AOR_HANDOFF, PACKAGE_INTRO };

export const IMPORT_SCREEN = {
  title: "Import your Granted package",
  filePickerLabel: "Choose a .granted.json file",
  pasteLabel: "Or paste the exported package text",
  importButton: "Import package",
  successMessage: "Package verified and imported.",
  failurePrefix: "This package couldn't be verified — re-export from Granted and try again.",
} as const;

export const REVIEW_SCREEN = {
  title: "Review before filling",
  intro: PACKAGE_INTRO.note,
  groundedSectionTitle: "Will be filled",
  gapSectionTitle: "You provide — left blank",
  excludedSectionTitle: "Left for you — never auto-filled",
  provenanceLabel: (source: string) => `Source: ${source}`,
  gapLabel: "You provide this in the portal.",
  excludedLabel: "Signature, date, and credential fields are never auto-filled.",
} as const;

export const FILL_PROGRESS_SCREEN = {
  title: "Filling this page",
  fillButton: "Fill this page",
  summaryLine: (filled: number, gaps: number, unmapped: number) =>
    `${filled} filled and verified · ${gaps} left for you · ${unmapped} couldn't be located`,
} as const;

/** Truthful, per-outcome label (INV-10) — never claims a value the portal doesn't actually hold. */
export const FILL_OUTCOME_LABELS: Record<FillOutcome, string> = {
  filled_verified: "Filled & verified",
  filled_unverified: "Filled — portal shows something different, check it",
  gap: "Gap — you provide this",
  unmapped: "Couldn't locate this field on the page",
  not_in_package: "Not present in this package",
  human_edit_kept: "Kept your edit — we didn't overwrite it",
  excluded: "Left for you — never auto-filled",
  portal_only: "Portal control — not part of your package",
  refused_credential: "Refused — this looks like a credential field",
};

export const NAVIGATE_SCREEN = {
  title: "Go to the next section",
  nextButton: "Go to next section",
  blockedMessage:
    "The next control on this page looks like a submit/sign/certify control. This extension never clicks that — review this section yourself, then continue in the portal.",
  unknownStepMessage: "Couldn't confirm which section of the form you're on. Review the page yourself before continuing.",
} as const;

/** Terminal boundary panel (spec §5.1 step 4) — verbatim register of AOR_HANDOFF. */
export const TERMINAL_SCREEN = {
  eyebrow: AOR_HANDOFF.eyebrow,
  headline: AOR_HANDOFF.headline,
  body: AOR_HANDOFF.body,
  cta: AOR_HANDOFF.cta,
} as const;

export const CLEAR_PACKAGE = {
  button: "Clear package",
  confirm: "This removes the imported package from this browser.",
} as const;
