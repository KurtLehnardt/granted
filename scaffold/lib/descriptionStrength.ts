import { tokenize } from "./retrieval/bm25";

/**
 * Company-description strength — the "is this description going to retrieve
 * well?" meter shown under the description box.
 *
 * WHY NOT LENGTH / UNIQUE-WORD COUNT
 * ----------------------------------
 * The obvious meter (like a password meter: longer + more distinct words =
 * stronger) is actively misleading here, and measurement on the real corpus
 * showed it inverting the two cases that matter most. Embedding the 791-program
 * corpus with nomic-embed-text and ranking it against each description gave:
 *
 *   description                                    uniq words   top-3 retrieved
 *   "vertical farm using llm for crop growth
 *    and serving food deserts"                          9       all 3 on-topic
 *                                                               (farm programs)
 *   "we are an innovative company leveraging
 *    cutting-edge technology to deliver scalable
 *    solutions and drive meaningful impact ..."        17       all 3 unrelated
 *                                                               (digital health,
 *                                                                innovation hub)
 *
 * The buzzword description is nearly twice as long, has nearly twice the unique
 * words, and retrieves nothing useful. A length-and-uniqueness meter would have
 * told the user the real description was the weak one. Cosine geometry doesn't
 * separate them either: both sit ~0.15 above the corpus median, and with these
 * embeddings EVERY program clears `candidateFloor`, so neither description is
 * losing candidates at retrieval — they differ in what comes back first.
 *
 * WHAT THIS MEASURES INSTEAD
 * --------------------------
 * Concrete, domain-bearing content. Words are tokenized with the SAME tokenizer
 * the BM25 retrieval layer uses (so the meter counts what retrieval counts),
 * then vague business filler is subtracted. What survives is roughly "terms that
 * could match a federal program's text". Filler is also penalized directly, so
 * padding a thin description with buzzwords lowers the score instead of raising
 * it — the behaviour the counterexample above demands.
 *
 * It is a HEURISTIC and deliberately a modest one: it cannot tell a true claim
 * from a false one, or a real technology from an invented one. It answers only
 * "does this carry enough specific content to retrieve on", which is the
 * question the box in front of the user is actually asking.
 */

/**
 * Vague business filler: words that are common in company blurbs, carry almost
 * no sector signal, and inflate a naive word count. Kept separate from the
 * retrieval tokenizer's stopword list — these are not grammatical stopwords,
 * they are content-shaped words that happen to say nothing.
 *
 * VALIDATED AGAINST THE CORPUS, not intuition. A word earns a place here only
 * if it is useless for retrieval, which happens at both extremes of document
 * frequency: very common in program text (little IDF to give — "state" 43%,
 * "service" 37%, "technology" 24%) or essentially absent from it (matches
 * nothing — "company" 0.8%, "startup" 0.8%, "customer" 0.8%).
 *
 * Words in the MIDDLE are real domain terms and were deliberately REMOVED after
 * measuring: "advanced" (11.3% of programs — "advanced manufacturing" is a
 * federal category, and the repo's own manufacturing sample company uses it),
 * "market" (6.6%), "generation" (6.1%), "efficiency" (5.2%), "next" (4.3%),
 * "product" (3.9%). Calling those filler penalized descriptions for using the
 * corpus's own vocabulary.
 */
export const FILLER_WORDS: ReadonlySet<string> = new Set([
  "innovative", "innovation", "innovating", "cutting", "edge", "leading", "world",
  "class", "best", "scalable", "solution", "solutions", "seamless", "robust",
  "disruptive", "revolutionary", "transformative", "synergy", "synergies",
  "leverage", "leveraging", "leverages", "empower", "empowering", "empowers",
  "enable", "enabling", "enables", "deliver", "delivering", "delivers",
  "drive", "driving", "drives", "impact", "impactful", "meaningful",
  "stakeholder", "stakeholders", "ecosystem", "holistic", "bespoke",
  "state", "art", "premier", "unparalleled",
  "mission", "driven", "passionate", "dedicated", "committed", "proven",
  "platform", "technology", "technologies", "company", "business", "startup",
  "customer", "customers", "client", "clients",
  "service", "services", "value", "quality",
  "efficient", "effective", "optimize", "optimise", "optimized",
  "streamline", "streamlined", "modern", "powerful",
  "unique", "exciting", "great", "amazing", "excellence",
]);

/**
 * Distinct content words at or above which specificity is considered saturated.
 *
 * Calibrated against the four curated sample companies in data/precomputed.json
 * — known-good descriptions that each return 33 matches. They carry 12–14
 * content words, so a threshold above that graded the product's own exemplars
 * as "thin", which is the meter being wrong rather than the samples.
 */
const SATURATION_WORDS = 15;

/** Points available from specificity alone, before facet credit. */
const SPECIFICITY_POINTS = 75;

/**
 * Credit for naming a concrete size. Not padding: several federal programs screen
 * on headcount or revenue, and all four curated sample companies state theirs.
 *
 * Size is the ONLY facet scored, because it is the only one detectable
 * reliably — it is numeric. An earlier version also scored "does it say who
 * this is for", by keyword. That was wrong in both directions: it fired on the
 * bare preposition "for", and it MISSED "distributing produce into
 * USDA-designated food deserts" because those exact nouns weren't in the list —
 * docking a good description 20 points and then advising it to "say who it's
 * for" when it already had. Advice that confidently contradicts the text in
 * front of the user is worse than no advice, and no word list fixes that, so
 * the facet is gone and the prompt now lives in the general specificity hint.
 */
const SCALE_POINTS = 25;

/** Band cutoffs on the 0–100 score. */
const FAIR_AT = 45;
const STRONG_AT = 75;

export type StrengthBand = "weak" | "fair" | "strong";

export interface DescriptionStrength {
  /** 0–100. Not a probability — a relative guide. */
  score: number;
  band: StrengthBand;
  /** Distinct, non-filler words the retrieval layer would actually see. */
  contentWordCount: number;
  /** Distinct filler words found, in first-seen order — shown back to the user. */
  fillerFound: string[];
  /** Short, specific, actionable lines. Empty when the description is strong. */
  suggestions: string[];
}

/** Does the text name a concrete scale/size (headcount, revenue, money)? */
function mentionsScale(text: string): boolean {
  return /\b\d+[\d,.]*\s*(people|employees|staff|person|-person|k|m|million|billion)\b/i.test(text) ||
    /\$\s?\d/.test(text) ||
    /\b\d+\s*(year|years)\b/i.test(text);
}

/**
 * Score a company description. Pure: no network, no DOM, safe to call on every
 * keystroke.
 */
export function scoreDescription(input: string | null | undefined): DescriptionStrength {
  const text = (input ?? "").trim();
  if (!text) {
    return {
      score: 0,
      band: "weak",
      contentWordCount: 0,
      fillerFound: [],
      suggestions: ["Describe what you build, who it's for, and what the funding would do."],
    };
  }

  const tokens = tokenize(text);
  const fillerFound: string[] = [];
  const contentWords = new Set<string>();
  let fillerCount = 0;
  for (const t of tokens) {
    if (FILLER_WORDS.has(t)) {
      fillerCount++;
      if (!fillerFound.includes(t)) fillerFound.push(t);
    } else {
      contentWords.add(t);
    }
  }

  const contentWordCount = contentWords.size;
  // Specificity saturates: past ~SATURATION_WORDS distinct content words, more
  // words stop adding retrieval signal, so they stop adding score.
  const specificity = Math.min(1, contentWordCount / SATURATION_WORDS);
  const hasScale = mentionsScale(text);
  const raw = specificity * SPECIFICITY_POINTS + (hasScale ? SCALE_POINTS : 0);
  // Filler is measured against ALL tokens, so a description that is mostly
  // buzzwords is pulled down however long it is. Capped at 0.6 so filler can
  // dilute a real description without erasing it.
  const fillerRatio = tokens.length ? fillerCount / tokens.length : 0;
  const fillerPenalty = Math.min(0.6, fillerRatio * 1.5);

  const score = Math.round(Math.max(0, Math.min(100, raw * (1 - fillerPenalty))));
  const band: StrengthBand = score >= STRONG_AT ? "strong" : score >= FAIR_AT ? "fair" : "weak";

  const suggestions: string[] = [];
  if (contentWordCount < SATURATION_WORDS) {
    suggestions.push("Add specifics: the materials, methods or techniques you actually use, the sector you work in, and who benefits.");
  }
  if (fillerFound.length >= 3) {
    suggestions.push(`Replace vague words (${fillerFound.slice(0, 4).join(", ")}) with concrete ones — they match nothing in a federal program's text.`);
  }
  if (!hasScale) {
    suggestions.push("Mention your size or stage (headcount, revenue, years operating) — several programs screen on it.");
  }

  return { score, band, contentWordCount, fillerFound, suggestions };
}
