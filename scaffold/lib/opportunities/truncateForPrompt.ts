/**
 * Prioritizes eligibility-relevant sentences when a long description must be
 * truncated for the LLM prompt, rather than always keeping just the first
 * N characters. Real reported gap: a California grant's full description
 * genuinely stated its CBO/beneficiary-school eligibility requirements, but
 * they appeared past the old hard 1200-char cutoff, so the LLM never saw
 * them when writing "what could make you ineligible" — not a missing-data
 * problem, a truncation-ORDER problem.
 *
 * Always keeps the opening sentence (title/lead-in, for basic context),
 * then fills the remaining budget with the highest-scoring
 * eligibility-relevant sentences first (by keyword hits), re-sorted back
 * into their ORIGINAL order once selected so the result still reads
 * coherently top-to-bottom rather than scrambled. A gap between
 * non-adjacent kept sentences is marked with an ellipsis so the LLM doesn't
 * read false continuity across what was cut.
 *
 * Falls back to ordinary head-first truncation when nothing scores above
 * zero (keyword hits break ties by original position) — so a description
 * with no eligibility-shaped language at all truncates exactly as the old
 * `description.slice(0, maxLength)` did.
 */

const ELIGIBILITY_KEYWORDS = [
  "must",
  "require",
  "eligib",
  "shall",
  "applicant",
  "beneficiary",
  "demonstrat",
  "written agreement",
  "certif",
  "registration",
  "non-profit",
  "nonprofit",
  "501(c)",
  "small business",
  "restricted to",
  "limited to",
  "only ",
  "qualif",
  "baseline requirement",
];

function eligibilityScore(sentence: string): number {
  const lower = sentence.toLowerCase();
  let score = 0;
  for (const kw of ELIGIBILITY_KEYWORDS) {
    if (lower.includes(kw)) score += 1;
  }
  return score;
}

const GAP_MARKER = " […] ";

/** Joins the sentences at `keptIndices` (always including 0, the opening
 * sentence) exactly as the real output would render, so callers can check
 * the TRUE assembled length rather than an estimate. */
function assemble(sentences: string[], keptIndices: number[]): string {
  let result = sentences[0]!;
  let lastKept = 0;
  for (const idx of keptIndices.slice(1)) {
    result += idx === lastKept + 1 ? ` ${sentences[idx]}` : `${GAP_MARKER}${sentences[idx]}`;
    lastKept = idx;
  }
  return result;
}

export function truncateDescriptionForPrompt(description: string, maxLength: number): string {
  if (description.length <= maxLength) return description;

  // Split into sentence-like chunks on a terminator followed by whitespace,
  // keeping the terminator with the preceding chunk (lookbehind) so no glue
  // punctuation needs to be reattached on rejoin.
  const sentences = description.split(/(?<=[.!?])\s+/).filter((s) => s.length > 0);
  if (sentences.length <= 1) return description.slice(0, maxLength);

  const opening = sentences[0]!;
  if (opening.length >= maxLength) return opening.slice(0, maxLength);

  const rest = sentences.slice(1).map((text, i) => ({ index: i + 1, text, score: eligibilityScore(text) }));
  const byScoreDesc = [...rest].sort((a, b) => b.score - a.score || a.index - b.index);

  // Tentatively add each candidate (highest-scoring first) and check the
  // REAL assembled length — not an estimated per-sentence cost — before
  // committing. A flat "+1 for a joining space" estimate undercounts any
  // sentence that ends up joined by the 5-char GAP_MARKER instead of a
  // space, which let the final cap below silently cut a selected
  // eligibility sentence mid-word. Checking the true rendered length at
  // each step removes the need for that blind cap entirely.
  let selected = [0];
  for (const s of byScoreDesc) {
    const candidate = [...selected, s.index].sort((a, b) => a - b);
    if (assemble(sentences, candidate).length <= maxLength) {
      selected = candidate;
    }
  }

  return assemble(sentences, selected);
}
