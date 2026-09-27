import type { Tier, CriterionCheck } from "../types";

/**
 * E3 — the PURE, dependency-free core of two-pass candidate scoring
 * (flag `e3_two_pass`, default OFF). No SDK, no network, no `lib/match.ts`
 * import (which would be circular) — so it is unit-testable in isolation and
 * safe to call from `lib/claude.ts`.
 *
 * Two-pass splits the single expensive `explainMatches` call into:
 *   - Pass A: a cheap SCORE-ONLY sweep over the WHOLE candidate set on the
 *     Haiku-class model — one `{ id, score }` per candidate.
 *   - Pass B: the FULL narrative (whyCare/whyFit/whyIneligible/whatToVerify/
 *     whatToDoNext + criteria) on the expensive model, ONLY for the candidates
 *     whose Pass-A score clears `PROMOTION_FLOOR`.
 * Non-promoted candidates keep their Pass-A score (so tiers still compute in
 * `lib/match.ts` via `tierFromScore`) — they simply don't spend on narrative.
 *
 * This module owns the deterministic glue: which candidates promote, and how
 * the two passes merge back into the single `Assessment[]` shape
 * `explainMatches` already returns. The Anthropic calls themselves live in
 * `lib/claude.ts`.
 */

/** The full per-candidate assessment shape `explainMatches` returns. */
export type Assessment = {
  id: string;
  score: number;
  tier: Tier;
  criteria: CriterionCheck[];
  whyCare: string;
  whyFit: string;
  whyIneligible: string;
  whatToVerify: string;
  whatToDoNext: string;
};

/** One Pass-A result: just an id and its cheap score-only fit score. */
export type PassAScore = { id: string; score: number };

/**
 * PROMOTION THRESHOLD — a candidate whose Pass-A score is at or above this gets
 * the full narrative (Pass B); below it, it keeps its score-only assessment.
 *
 * Tied to `tierFromScore`'s ADJACENT boundary (25) — the LOWEST band that
 * renders as a real tier (adjacent/verify/likely all render; only `none` < 25
 * does not). On HOSTED (`lib/claude.ts`'s `e3TwoPassTopN`, uncapped there),
 * every candidate that could render as a real tier still gets a full narrative
 * under two-pass, and only the non-rendering `none` bulk is skipped — which is
 * exactly where the cost/latency is saved. On LOCAL, Pass B additionally caps
 * narration to the top `E3_TWO_PASS_TOP_N` promoted candidates by Pass-A score
 * (a small local model is too slow to narrate every promoted candidate) — a
 * promoted candidate past that cap still renders its real tier, just with a
 * blank narrative, via `scoreOnlyAssessment`'s Pass-A score. Kept as a literal
 * (not imported from `lib/match.ts`) to avoid a circular import; the value must
 * stay equal to that adjacent boundary. If `tierFromScore`'s adjacent boundary
 * ever moves, move this with it.
 */
export const PROMOTION_FLOOR = 25;

/** Build a set of the ids whose Pass-A score clears `floor` (promoted). */
export function promotedIds(passA: PassAScore[], floor: number = PROMOTION_FLOOR): Set<string> {
  const ids = new Set<string>();
  for (const s of passA) {
    if (Number.isFinite(s.score) && s.score >= floor) ids.add(s.id);
  }
  return ids;
}

/**
 * A score-only assessment for a NON-promoted candidate: its Pass-A score, empty
 * narrative/criteria. `lib/match.ts` recomputes the tier from the score via
 * `tierFromScore`, so the `tier` field here is only a self-consistent
 * placeholder — a non-promoted candidate is (by definition of `PROMOTION_FLOOR`)
 * below the adjacent boundary, i.e. tier `none`.
 */
export function scoreOnlyAssessment(id: string, score: number): Assessment {
  return {
    id,
    score,
    tier: "none",
    criteria: [],
    whyCare: "",
    whyFit: "",
    whyIneligible: "",
    whatToVerify: "",
    whatToDoNext: "",
  };
}

/**
 * Merge Pass A + Pass B back into the single `Assessment[]` `explainMatches`
 * returns, in `candidateIds` order.
 *
 * For each candidate id:
 *   - if Pass B returned a full assessment for it → use that Pass-B assessment
 *     (its score is the authoritative one, same as the single pass would have
 *     produced). WHICH candidates Pass B narrates (floor + top-N-by-score) is
 *     entirely the caller's decision (`lib/claude.ts`) — this merge just takes
 *     whatever Pass B actually returned;
 *   - otherwise → a score-only assessment carrying its Pass-A score, so it still
 *     computes a tier downstream and is never silently dropped. This also covers
 *     a candidate the caller SELECTED for narration whose Pass-B batch failed
 *     (graceful degradation): it keeps its Pass-A score rather than vanishing.
 *
 * A Pass-A score is required for a candidate to appear at all; a candidate with
 * no Pass-A score (Pass A failed to return it) is omitted, mirroring how the
 * single pass only returns ids the model actually scored.
 */
export function assembleTwoPass(
  candidateIds: string[],
  passA: PassAScore[],
  passB: Assessment[],
): Assessment[] {
  const passAById = new Map<string, number>();
  for (const s of passA) passAById.set(s.id, s.score);
  const passBById = new Map<string, Assessment>();
  for (const a of passB) passBById.set(a.id, a);

  const out: Assessment[] = [];
  for (const id of candidateIds) {
    const passAScore = passAById.get(id);
    if (passAScore === undefined) continue; // Pass A never scored it — omit.
    out.push(passBById.get(id) ?? scoreOnlyAssessment(id, passAScore));
  }
  return out;
}
