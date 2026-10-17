/**
 * Criteria-based composite score. The LLM's score picks the BAND (its
 * valuable signal); position within the band comes from criteria met/total
 * (70%) and retrieval cosine similarity (30%), giving non-round numbers.
 */
const BANDS = [
  { min: 0, max: 20 }, // no fit
  { min: 21, max: 34 }, // adjacent
  { min: 35, max: 54 }, // partial
  { min: 55, max: 74 }, // strong
  { min: 75, max: 100 }, // exceptional
] as const;

function bandFor(llmScore: number): { min: number; max: number } {
  const s = Math.round(llmScore);
  return BANDS.find((b) => s >= b.min && s <= b.max) ?? BANDS[0];
}

export function computeCompositeScore(
  llmScore: number,
  criteria: { met: boolean }[],
  cosineSimilarity?: number,
): number {
  // Non-finite: skip compositing. Score 0 = hard no-fit: pass through.
  if (!Number.isFinite(llmScore)) return llmScore;
  const score = Math.max(0, Math.min(100, llmScore));
  if (score === 0) return 0;
  const band = bandFor(score);
  const total = criteria.length;
  const met = criteria.filter((c) => c.met).length;
  const criteriaRatio = total > 0 ? met / total : 0.5;
  const rawCos =
    cosineSimilarity === undefined || !Number.isFinite(cosineSimilarity) ? 0.5 : cosineSimilarity;
  const cosine = Math.max(0, Math.min(1, rawCos));
  const position = criteriaRatio * 0.7 + cosine * 0.3;
  return Math.round(band.min + (band.max - band.min) * position);
}
