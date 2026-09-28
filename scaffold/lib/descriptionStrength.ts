/**
 * Company-description strength — the meter shown under the description box.
 *
 * LENGTH, DELIBERATELY
 * --------------------
 * The score is word count and nothing else. That is a product decision taken
 * knowingly: the guidance to users is "a paragraph or two", so the meter
 * measures the thing the guidance asks for, and the placeholder, the meter and
 * the advice all say the same thing. A meter scoring something other than what
 * the placeholder asks for would be the confusing option.
 *
 * What it therefore cannot do, so nobody is surprised later: it cannot tell
 * specific prose from padding. Measured against the real 791-program corpus,
 * this description —
 *
 *   "we are an innovative company leveraging cutting-edge technology to
 *    deliver scalable solutions and drive meaningful impact ..."   (24 words)
 *
 * retrieves three unrelated programs, while this one —
 *
 *   "vertical farm using llm for crop growth and serving food deserts"
 *                                                                 (11 words)
 *
 * retrieves three on-topic farm programs. On length the buzzword blurb scores
 * higher. That is the accepted trade: length is the signal a user can act on
 * without being lectured about word choice, and in the normal case — somebody
 * writing honestly about their own company — more words do carry more
 * retrievable detail. If padding ever matters in practice, this file is the
 * place to fix it, and `git log` here has a worked content-based implementation
 * to start from.
 *
 * Calibration comes from lib/testCases.ts — the four sample companies the app
 * ships and replays from the welcome guide. They run 26–38 words and each
 * returns 33 matches, so the thresholds below must not call them thin.
 */

/** Below this, the description is shorter than half a paragraph. */
const FAIR_AT_WORDS = 20;

/** At or above this, the description is the "paragraph or two" we ask for. */
const STRONG_AT_WORDS = 60;

export type StrengthBand = "weak" | "fair" | "strong";

export interface DescriptionStrength {
  /** 0–100, scaled linearly to STRONG_AT_WORDS. Not a probability — a guide. */
  score: number;
  band: StrengthBand;
  /** Words counted, split on whitespace. */
  wordCount: number;
  /** Short, actionable lines. Empty once the description is long enough. */
  suggestions: string[];
}

/** Words, split on any run of whitespace. */
export function countWords(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  return trimmed.split(/\s+/).length;
}

/**
 * Score a company description on length. Pure: no network, no DOM, safe to call
 * on every keystroke.
 */
export function scoreDescription(input: string | null | undefined): DescriptionStrength {
  const text = (input ?? "").trim();
  const wordCount = countWords(text);

  if (!wordCount) {
    return {
      score: 0,
      band: "weak",
      wordCount: 0,
      suggestions: ["Describe what you build, who it's for, and what the funding would do."],
    };
  }

  const score = Math.round(Math.max(0, Math.min(100, (wordCount / STRONG_AT_WORDS) * 100)));
  const band: StrengthBand =
    wordCount >= STRONG_AT_WORDS ? "strong" : wordCount >= FAIR_AT_WORDS ? "fair" : "weak";

  const suggestions: string[] = [];
  if (band === "weak") {
    suggestions.push(
      "Grant matches improve with more detail — aim for a paragraph or two covering what you build, who it's for, your size, and what the funding would do.",
    );
  } else if (band === "fair") {
    suggestions.push(
      "Another paragraph will sharpen your matches — add your size, stage, and what the funding would pay for.",
    );
  }

  return { score, band, wordCount, suggestions };
}
