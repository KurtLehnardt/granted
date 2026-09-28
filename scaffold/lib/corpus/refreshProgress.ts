/** Ordered pipeline stages the refresh script moves through, and the overall-pct weight of each. */
export const STAGE_ORDER = [
  "grants.gov search",
  "grants.gov details",
  "sam.gov",
  "sbir",
  "procurement",
  "selecting",
  "embedding",
  "saving",
] as const;

export type RefreshStage = (typeof STAGE_ORDER)[number];

/** Rough share of wall-clock time each stage tends to take; must sum to 100. */
export const STAGE_WEIGHTS: Record<RefreshStage, number> = {
  "grants.gov search": 5,
  "grants.gov details": 25,
  "sam.gov": 10,
  sbir: 10,
  procurement: 10,
  selecting: 5,
  embedding: 30,
  saving: 5,
};

const STAGE_LABELS: Record<RefreshStage, string> = {
  "grants.gov search": "Searching grants.gov",
  "grants.gov details": "Fetching grants.gov details",
  "sam.gov": "Fetching SAM.gov",
  sbir: "Fetching SBIR/STTR",
  procurement: "Fetching procurement records",
  selecting: "Selecting…",
  embedding: "Embedding",
  saving: "Saving",
};

function cumulativeBefore(stage: RefreshStage): number {
  let sum = 0;
  for (const s of STAGE_ORDER) {
    if (s === stage) break;
    sum += STAGE_WEIGHTS[s];
  }
  return sum;
}

/** Fraction (0–1) of a stage completed, given a done/total pair. Unknown total reads as 0 (just started). */
export function stageFraction(done?: number, total?: number): number {
  if (!total || total <= 0) return 0;
  return Math.max(0, Math.min(1, (done ?? 0) / total));
}

/** Overall pct (0–100, rounded) from stage weights: everything before `stage` plus the fraction within it. */
export function overallPct(stage: RefreshStage, done?: number, total?: number): number {
  const before = cumulativeBefore(stage);
  const within = STAGE_WEIGHTS[stage] * stageFraction(done, total);
  return Math.max(0, Math.min(100, Math.round(before + within)));
}

/** Human label for the current stage, e.g. "Embedding 120 of 340 new". */
export function stageLabel(stage: RefreshStage, done?: number, total?: number): string {
  const base = STAGE_LABELS[stage];
  if (stage === "embedding" && total) return `Embedding ${done ?? 0} of ${total} new`;
  // "selecting" done/total is always 1 of 1 (a single pass, not a count worth showing).
  if (stage === "selecting") return base;
  if (done != null && total != null && total > 0) return `${base} (${done} of ${total})`;
  return base;
}
