import { describe, expect, test } from "vitest";
import {
  IMPORT_SCREEN,
  REVIEW_SCREEN,
  FILL_PROGRESS_SCREEN,
  FILL_OUTCOME_LABELS,
  NAVIGATE_SCREEN,
  TERMINAL_SCREEN,
  CLEAR_PACKAGE,
  AOR_HANDOFF,
  PACKAGE_INTRO,
} from "../src/popup/copy";

/**
 * Positive submission/eligibility CONFIRMATIONS the copy must never state.
 * Mirrors `scaffold/lib/apply/__tests__/package.test.ts`'s
 * `SUBMIT_CONFIRMATION_PATTERNS`.
 */
const SUBMIT_CONFIRMATION_PATTERNS: RegExp[] = [
  /application (has been |was )?submitted\b/i,
  /we (have |)submitted/i,
  /automatically submit/i,
  /you('ve| have) won\b/i,
  /application (was |has been )?approved\b/i,
  /you (are|'re) eligible/i,
  /you qualify/i,
  /guaranteed/i,
  /filed on your behalf/i,
  /we (are|'re) your (aor|e-biz poc)/i,
];

/** Mirrors `scaffold/scripts/banned-phrases.mjs` BANNED_PHRASES (definitive-eligibility language). */
const BANNED_PHRASES = ["you qualify", "you are eligible", "you're eligible", "guaranteed", "you will receive", "you will be awarded"];

function findBannedPhrases(text: string): string[] {
  const lower = text.toLowerCase();
  return BANNED_PHRASES.filter((phrase) => lower.includes(phrase));
}

function collectAllCopyStrings(): string[] {
  const strings: string[] = [
    IMPORT_SCREEN.title,
    IMPORT_SCREEN.filePickerLabel,
    IMPORT_SCREEN.pasteLabel,
    IMPORT_SCREEN.importButton,
    IMPORT_SCREEN.successMessage,
    IMPORT_SCREEN.failurePrefix,
    REVIEW_SCREEN.title,
    REVIEW_SCREEN.intro,
    REVIEW_SCREEN.groundedSectionTitle,
    REVIEW_SCREEN.gapSectionTitle,
    REVIEW_SCREEN.excludedSectionTitle,
    REVIEW_SCREEN.gapLabel,
    REVIEW_SCREEN.excludedLabel,
    FILL_PROGRESS_SCREEN.title,
    FILL_PROGRESS_SCREEN.fillButton,
    ...Object.values(FILL_OUTCOME_LABELS),
    NAVIGATE_SCREEN.title,
    NAVIGATE_SCREEN.nextButton,
    NAVIGATE_SCREEN.blockedMessage,
    NAVIGATE_SCREEN.unknownStepMessage,
    TERMINAL_SCREEN.eyebrow,
    TERMINAL_SCREEN.headline,
    TERMINAL_SCREEN.body,
    TERMINAL_SCREEN.cta,
    CLEAR_PACKAGE.button,
    CLEAR_PACKAGE.confirm,
    AOR_HANDOFF.eyebrow,
    AOR_HANDOFF.headline,
    AOR_HANDOFF.body,
    AOR_HANDOFF.cta,
    PACKAGE_INTRO.eyebrow,
    PACKAGE_INTRO.note,
  ];
  return strings;
}

describe("copy-lint (INV-12) — every popup/copy string is honest", () => {
  const allCopy = collectAllCopyStrings().join("  ");

  test("contains NO submit/eligibility CONFIRMATION phrasing", () => {
    for (const re of SUBMIT_CONFIRMATION_PATTERNS) {
      expect(allCopy).not.toMatch(re);
    }
  });

  test("contains NO banned definitive-eligibility phrasing", () => {
    expect(findBannedPhrases(allCopy)).toEqual([]);
  });

  test("the terminal panel mirrors AOR_HANDOFF verbatim (headline + cta)", () => {
    expect(TERMINAL_SCREEN.headline).toBe("Review & submit via your authorized AOR");
    expect(TERMINAL_SCREEN.cta).toBe("Review & submit via your authorized AOR");
    expect(TERMINAL_SCREEN.body).toMatch(/authorized organization representative/i);
  });

  test("individually scans each copy string (not just the joined blob) for confirmation phrasing", () => {
    for (const str of collectAllCopyStrings()) {
      for (const re of SUBMIT_CONFIRMATION_PATTERNS) {
        expect(str).not.toMatch(re);
      }
    }
  });
});
