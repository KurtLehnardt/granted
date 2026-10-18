/**
 * Deterministic scorer (flag `dbsf_scorer`): Distribution-Based Score Fusion.
 * Each continuous signal is normalized against the candidate set's own
 * distribution, norm = (x - mu + 3*sigma) / (6*sigma), clipped to [0,1]. Criteria
 * ratio is first shrunk with a Beta(2,2) prior so 1/1 doesn't outrank 9/10.
 * Absent signals are dropped and the remaining weights renormalized.
 */
export type EligibilityStatus = "eligible" | "conditional" | "unknown" | "excluded";

export interface ScoreSignals {
  cosine?: number;
  /** Raw, un-normalized cosine in [0,1]; anchors the relative DBSF score to an absolute scale. */
  rawCosine?: number;
  bm25?: number;
  criteriaMet?: number;
  criteriaCount?: number;
  metadataOverlap?: number;
  eligibility: EligibilityStatus;
}

const WEIGHTS = { cosine: 0.3, criteria: 0.3, bm25: 0.15, eligibility: 0.15, metadata: 0.1 } as const;
const ELIGIBILITY_VALUE: Record<EligibilityStatus, number> = { eligible: 1, conditional: 0.6, unknown: 0.3, excluded: 0 };
const EXCLUDED_CAP = 15;
const PRIOR = { alpha: 2, beta: 2 };

/** Beta-Binomial posterior mean of the criteria hit rate. */
export function shrinkCriteria(met: number, count: number): number {
  if (!(count >= 0)) throw new RangeError("shrinkCriteria: count must be >= 0");
  met = Math.max(0, Math.min(count, met));
  return (met + PRIOR.alpha) / (count + PRIOR.alpha + PRIOR.beta);
}

/** DBSF-normalize present values; undefined stays undefined. Zero spread maps to 0.5. */
function dbsf(values: (number | undefined)[]): (number | undefined)[] {
  const xs = values.filter((v): v is number => v !== undefined && Number.isFinite(v));
  if (xs.length === 0) return values.map(() => undefined);
  const mu = xs.reduce((a, b) => a + b, 0) / xs.length;
  const sigma = Math.sqrt(xs.reduce((a, b) => a + (b - mu) ** 2, 0) / xs.length);
  return values.map((v) => {
    if (v === undefined || !Number.isFinite(v)) return undefined;
    if (sigma === 0) return 0.5;
    return Math.max(0, Math.min(1, (v - mu + 3 * sigma) / (6 * sigma)));
  });
}

/** Score a candidate set; returns 0-100 integers in input order. */
export function dbsfScores(candidates: ScoreSignals[]): number[] {
  const cos = dbsf(candidates.map((c) => c.cosine));
  const bm = dbsf(candidates.map((c) => c.bm25));
  const meta = dbsf(candidates.map((c) => c.metadataOverlap));
  const crit = dbsf(
    candidates.map((c) =>
      c.criteriaMet !== undefined && c.criteriaCount !== undefined
        ? shrinkCriteria(c.criteriaMet, c.criteriaCount)
        : undefined,
    ),
  );
  return candidates.map((c, i) => {
    const parts: [number | undefined, number][] = [
      [cos[i], WEIGHTS.cosine],
      [crit[i], WEIGHTS.criteria],
      [bm[i], WEIGHTS.bm25],
      [ELIGIBILITY_VALUE[c.eligibility], WEIGHTS.eligibility],
      [meta[i], WEIGHTS.metadata],
    ];
    let sum = 0;
    let wTotal = 0;
    for (const [v, w] of parts) {
      if (v === undefined) continue;
      sum += v * w;
      wTotal += w;
    }
    const dbsfScore = (sum / wTotal) * 100;
    // DBSF is relative to the candidate set (~50 +/- spread); blend with raw cosine so
    // absolute thresholds (scoreFloor, tier cutoffs) stay meaningful. No cosine: pure DBSF.
    const anchor = c.rawCosine !== undefined && Number.isFinite(c.rawCosine) ? c.rawCosine * 100 : undefined;
    const blended = anchor === undefined ? dbsfScore : dbsfScore * 0.6 + anchor * 0.4;
    const score = Math.max(0, Math.min(100, Math.round(blended)));
    // Defense in depth: match.ts pre-filters excluded candidates, so this is normally unreachable.
    return c.eligibility === "excluded" ? Math.min(score, EXCLUDED_CAP) : score;
  });
}
