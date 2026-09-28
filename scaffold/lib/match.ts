import { embed, cosine, assertEmbeddingDimsMatch } from "./embed";
import { extractProfile, explainMatches, explainMatchesTwoPass, explainWeakField, type Assessment, type TwoPassProgressDetail } from "./claude";
import type { Opportunity, OpportunityMap, StartupProfile, Match, Tier, AwardHistory } from "./types";
import { screen } from "./eligibility/screen";
import { annotateFreshness } from "./eligibility/freshness";
import { toCompanyProfile, toScreenableOpportunity, type KnownCompanyFacts } from "./eligibility/bridge";
import { getCorpus } from "./corpus/store";
import { dropExpiredOpportunities } from "./corpus/expiry";
import type { EligibilityDetermination } from "./contracts/eligibilityDetermination";
import { scoreOnlyAssessment } from "./scoring/twoPass";
import awards from "@/data/awards.json";
import { createCostMeter, type CostMeter } from "./metering/meter";
import { CURRENT_OPPORTUNITY_MAP_VERSION } from "./contracts/opportunityMap";
import { isFlagEnabled, isFlagExplicitlyDisabled } from "./flags";
import { isLocalLlm } from "./llm/client";
import { recommendFor, mapVerdict } from "./recommend";
import { getBM25Index, bm25Query } from "./retrieval/bm25";
import { fuseRankings } from "./retrieval/hybrid";
// F3 — weak-field redirects should name a few REAL Utah/SBA programs, not just
// categories. Wrapped around both explainWeakField() call sites below (the
// zero-candidate weakField() branch and the below-threshold branch in
// buildOpportunityMap); see lib/redirects/utahSbaPrograms.ts for the curated
// list and the (pure, hermetic) guarantee it makes.
import { ensureRealRedirects } from "./redirects/utahSbaPrograms";
import { deriveEnrichmentSignal, enrichmentQueryTerms, boostForOpportunity } from "./retrieval/enrich";

/**
 * CALIBRATION KNOBS — tune these against all four test cases before touching UI.
 *
 * These values are the current shipped calibration. If you change a knob here,
 * record the rationale in the same commit (see the inline notes on `scoreFloor`
 * below for the kind of audit trail expected). A full golden-set re-validation
 * (evals/golden-set.jsonl) remains the outstanding audit step.
 */
export const CALIBRATION = {
  /** Below this cosine similarity a program is never a candidate. */
  candidateFloor: 0.22,
  /** How many candidates go to Claude for scoring. */
  candidateCount: Number(process.env.LLM_CANDIDATE_COUNT) || 24,
  /** Verify/adjacent boundary. E1 re-derivation on the 968-opp MIXED corpus
   *  RAISED this 30 -> 33 to keep case-5's core GRANT fit honestly weak. The C1a
   *  per-type quota (NOT a low floor) is what makes non-grants REACHABLE; once
   *  scored, genuine non-grant fits land well clear of 33 — case-1 health-IT
   *  PROCUREMENT 35-42, case-3 SBIR/rd 35, case-2 procurement 38-52, case-4
   *  rd/procurement 38-78. Meanwhile case-5's education/STEM GRANTS (NDEP STEM,
   *  NSF "Fostering Innovation") oscillate up to ~32 run-to-run; at the old 30
   *  they over-matched as STRONG grants in ~half of runs — a breach of the sacred
   *  honest-no. 33 sits just above that grant-noise band, so case-5's borderline
   *  grants render as (permitted) ADJACENT and its weak-field finding stays robust
   *  while every genuinely-fitting non-grant still promotes. The residual
   *  case-1↔case-5 overlap (case-1's non-grant occasionally dips to ~30) is the
   *  tension the task anticipated: keep case-5 honest, do not over-fit case-1. */
  scoreFloor: 33,
  /** If fewer than this many matches clear scoreFloor, declare a weak field.
   *  1 = weak field means ZERO strong matches — cleanly isolates the case-5
   *  "no honest match" finding from thin-but-real cases (e.g. case 1's single
   *  strong NIH match), which case-5's large score margin keeps robust. */
  weakFieldThreshold: 1,
  /** C1a — per-type retrieval quota. Reserve at least this many candidates of
   *  EACH `kind` present among the floor-clearing set, so every instrument type
   *  (rd/SBIR, procurement, assistance, loan, scholarship) REACHES the LLM
   *  scorer instead of being crowded out by the 476 grants in a single global
   *  top-`candidateCount` cosine cut. These slots are ADDED to (unioned with)
   *  the global top-N — they never displace a strong grant. Purely deterministic
   *  (top-K-by-cosine per kind, tie-broken by opp id). Does NOT change scoring;
   *  it only makes underrepresented types reachable (scoreFloor stays Wave-3). */
  perTypeQuota: 3,
};

/**
 * C1 (architectural review): the legacy v1 `ruleGate()` pre-filter was REMOVED.
 *
 * It ran BEFORE the ELG-01 engine and silently dropped opportunities that then
 * reached no bucket at all — violating R8.2 ("never silently drop") and R8.4
 * ("never exclude on a model-inferred fact"). Both of its branches were
 * eligibility exclusions, NOT retrieval heuristics, so nothing conservative
 * remained to keep:
 *   1. `source==="sbir" && employees>500` gated on a MODEL-INFERRED employee
 *      count (`bridge.ts` marks `employees` as `model_inferred`). `screen()`
 *      renders exactly this fact as `unknown`, never `excluded`.
 *   2. `/only.*(IHE|state|tribal)/` over free-text eligibility prose — a greedy
 *      regex that matched 40/476 live corpus opps, including permissive
 *      multi-entity NOFOs (e.g. `grants-353936`, open to nonprofits AND IHEs),
 *      dropping them as if they were "IHE-only".
 *
 * `screen()` is now the SOLE eligibility authority: a size/entity mismatch flows
 * through the engine as `unknown`/`conditionally_eligible` (or, only for a
 * reviewed+trustworthy rule on a trustworthy fact, a VISIBLE `excluded`), never a
 * pre-screen silent drop.
 */

/**
 * Testability seam (H6): the real LLM/embedding/screen calls and the static
 * corpus are injectable so `buildOpportunityMap` can be exercised hermetically
 * (no network, no live model spend). Production callers omit `deps` and get the
 * real implementations; tests pass mocks + a fixture corpus.
 */
export type BuildDeps = {
  extractProfile: typeof extractProfile;
  embed: typeof embed;
  explainMatches: typeof explainMatches;
  /** E3 — the flag-`e3_two_pass`-ON scorer; same signature as `explainMatches`. */
  explainMatchesTwoPass: typeof explainMatchesTwoPass;
  explainWeakField: typeof explainWeakField;
  screen: typeof screen;
  corpus: Opportunity[];
};

const REAL_DEPS: Omit<BuildDeps, "corpus"> = {
  extractProfile,
  embed,
  explainMatches,
  explainMatchesTwoPass,
  explainWeakField,
  screen,
};

export function tierFromScore(score: number): Tier {
  // E1: "likely" lowered 75 -> 60. On the 968-opp corpus NO match ever reaches
  // 75 — the LLM's effective ceiling is ~72 and its prompt deliberately keeps
  // scores conservative — so "likely" was a DEAD tier. 60 lets genuinely strong
  // non-grant fits (case-2 procurement ~62, case-4 SBIR/rd ~72) reach the top
  // tier: the "promote into verify/LIKELY" half of the E1 goal. Safe for case-5
  // (its ceiling is ~32, far below 60). Bands: likely>=60, verify>=scoreFloor(33),
  // adjacent>=25, none<25. `highPotential`/`strong` stay score>=scoreFloor, so
  // likely⊂strong keeps the summary count and the component tier-filter consistent.
  if (score >= 60) return "likely";
  if (score >= CALIBRATION.scoreFloor) return "verify"; // >= 33 (E1)
  if (score >= 25) return "adjacent"; // 25-32: houses case-5's permitted honest adjacents
  return "none";
}

/**
 * A3-lite (awards provenance gate) — the raw shape of a row in
 * `data/awards.json`. `sourceUrl` is OPTIONAL here (this is the shape as it
 * arrives from the data file / a test fixture), unlike the required
 * `sourceUrl` in `AwardHistorySchema.recipients` (`lib/contracts/
 * opportunityMap.ts`): a row without one is a candidate for filtering, not a
 * schema violation, until it survives `filterVerifiedRows()` below.
 */
export type AwardRow = {
  company: string;
  program: string;
  agency: string;
  amount: number;
  year: number;
  state?: string;
  sameVertical?: boolean;
  sourceUrl?: string;
};

/**
 * A3-lite — the ONLY gate between raw award rows and anything a user sees.
 * Every `data/awards.json` row was cross-checked against the live SBIR.gov
 * bulk award CSV (firm + agency + program + award year + amount) and only
 * verified rows were written back with a real `sourceUrl`
 * (`https://www.sbir.gov/awards?firm=<firm>`); unverifiable rows were DROPPED
 * from the data file entirely. This filter is defense-in-depth on top of
 * that: it re-asserts the same guarantee at render time so a row can never
 * reach the UI without provenance, regardless of how it got into the awards
 * map (a future data refresh, a bad merge, a test fixture, etc.).
 */
export function filterVerifiedRows(rows: AwardRow[]): AwardRow[] {
  return rows.filter((r) => typeof r.sourceUrl === "string" && r.sourceUrl.length > 0);
}

/**
 * A3-lite — pure, hermetic computation of an `AwardHistory` from an already-
 * loaded row array (no `@/data/awards.json` import, no I/O). Filters to
 * verified rows FIRST, so `similarCompanies`/totals/medians/`recipients` all
 * reflect only rows with a real `sourceUrl`. Extracted out of `historyFor` so
 * tests can inject a fixture row set (mix of verified + unverified) instead
 * of depending on the real 4,020-row data file.
 */
export function historyFromRows(rows: AwardRow[], state?: string): AwardHistory | undefined {
  const verified = filterVerifiedRows(rows);
  if (verified.length === 0) return undefined;
  const amounts = verified.map((r) => r.amount).sort((a, b) => a - b);
  const mid = Math.floor(amounts.length / 2);
  return {
    similarCompanies: verified.length,
    totalAwarded: amounts.reduce((a, b) => a + b, 0),
    medianAward: amounts.length % 2 ? amounts[mid] : Math.round((amounts[mid - 1] + amounts[mid]) / 2),
    inState: verified.filter((r) => (r.state ?? "").toLowerCase() === (state ?? "utah").toLowerCase()).length,
    inVertical: verified.filter((r) => r.sameVertical).length,
    recipients: verified.slice(0, 8) as AwardHistory["recipients"],
  };
}

export function historyFor(oppId: string, state?: string): AwardHistory | undefined {
  const rows = (awards as any)[oppId] as AwardRow[] | undefined;
  if (!rows || rows.length === 0) return undefined;
  return historyFromRows(rows, state);
}

/** A real pipeline milestone, streamed to the client so the loading bar can
 *  reflect actual progress (not just a timer). `pct` is the fraction complete
 *  once this step has finished. */
export type StepEvent = { key: string; label: string; pct: number; detail?: string };

/**
 * R4b — always logs the structured per-search cost/latency line (there's no
 * real logging backend yet; see `track.ts`'s `defaultSink` for precedent),
 * and attaches `costDebug` to the result ONLY when `r4b_cost_debug` is on —
 * cost figures must never reach the end-user UI without that flag (CON-03
 * pattern: `lib/flags/registry.ts` + `env.ts`). Called from both
 * `buildOpportunityMap`'s normal return and the `weakField()` early exit, so
 * every completed search gets exactly one `[cost]` log line.
 *
 * Wrapped here too, on top of `CostMeter`'s own internal defensiveness
 * (belt-and-suspenders, per the R4b task's "a metering bug must never be the
 * reason a search fails") — this function itself must never throw.
 */
function finalizeCost(meter: CostMeter, result: OpportunityMap): void {
  try {
    const costSummary = meter.summary();
    meter.logSummary(costSummary);
    if (isFlagEnabled("r4b_cost_debug")) {
      result.costDebug = costSummary;
    }
  } catch (err) {
    console.warn("[metering] failed to finalize the cost summary for this search:", err);
  }
}

/**
 * Clamp a client-supplied candidate cap to a safe range. Users can LOWER it
 * (Settings → "Search depth") to speed up a slow local search at the cost of
 * scoring fewer opportunities. Floor of 4 so a run still returns something;
 * ceiling at the calibrated default (a higher value risks the scorer's
 * max_tokens budget). Absent / non-finite → the default.
 */
export function clampCandidateCount(requested: number | null | undefined): number {
  const def = CALIBRATION.candidateCount;
  if (requested == null || !Number.isFinite(requested)) return def;
  return Math.min(Math.max(4, Math.floor(requested)), def);
}

/**
 * Build a `Match` from one scored candidate. Pure — no eligibility screening,
 * no discernment verdict (both need context beyond a single assessment: a
 * shared `companyProfile` / the whole scored set respectively) and no funding/
 * summary aggregation (whole-set-only). This is deliberately the SAME shape
 * used both for the final, authoritative `matches` array AND for the
 * progressive per-batch preview emitted while scoring is still in flight, so
 * a streamed-in card never has to change shape once the full map replaces it.
 */
function baseMatchFromAssessment(a: Assessment, opp: Opportunity, profile: StartupProfile): Match {
  return {
    opportunity: opp,
    // Derive tier from the calibrated score thresholds so card tiers and the
    // summary's high-potential count (score >= scoreFloor) stay consistent.
    tier: tierFromScore(a.score),
    score: a.score,
    criteria: a.criteria ?? [],
    whyCare: a.whyCare,
    whyFit: a.whyFit,
    whyIneligible: a.whyIneligible,
    whatToVerify: a.whatToVerify,
    whatToDoNext: a.whatToDoNext,
    history: historyFor(opp.id, profile.location),
  };
}

/** Instant-cards: how many retrieved candidates get an early, unscored
 *  provisional card. A little above the UI's CARD_CAP (8) so that even after
 *  scoring reshuffles tiers, most of what was shown provisionally is still
 *  in the final list — without spamming the client with the whole
 *  candidateCount slice, most of which will never be shown. */
export const PROVISIONAL_PREVIEW_COUNT = 12;

export async function buildOpportunityMap(
  description: string,
  onStep?: (e: StepEvent) => void,
  deps: Partial<BuildDeps> = {},
  signal?: AbortSignal,
  companyFacts?: KnownCompanyFacts,
  maxCandidates?: number,
  // Progressive rendering: fired with a preview Match as soon as ITS batch is
  // scored, instead of the caller waiting for the whole candidate set. Optional
  // and best-effort — never affects the authoritative `matches` this function
  // returns, which is always built from the complete, awaited scorer result.
  onMatch?: (m: Match) => void,
  // INSTANT CARDS — fired for each retrieved candidate immediately after
  // retrieval, well before any LLM scoring call. Optional and best-effort,
  // exactly like `onMatch`: never affects the authoritative returned map.
  onProvisional?: (o: Opportunity) => void,
): Promise<OpportunityMap> {
  const d: BuildDeps = { ...REAL_DEPS, ...deps, corpus: deps.corpus ?? dropExpiredOpportunities(getCorpus()) };
  // Progress is best-effort: a reporting error must never fail the search.
  const step = (e: StepEvent) => { try { onStep?.(e); } catch { /* ignore */ } };
  step({ key: "start", label: "Reading the federal register…", pct: 5 });

  // R4b — one CostMeter per search, threaded through every LLM/embedding
  // call below (including the weakField() early-exit path). Every method on
  // it is internally defensive and never throws (lib/metering/meter.ts).
  const meter = createCostMeter();

  // INSTANT CARDS — 1 + 2 run IN PARALLEL, not sequentially. Profile extraction
  // is the ~44s local-LLM call that used to gate everything else; retrieval only
  // needs an EMBEDDING of the raw description, which is sub-second even on a
  // local embedding model. So we kick off extractProfile here WITHOUT awaiting
  // it, embed the raw description immediately below, and retrieve + stream
  // provisional candidates while the profile call is still in flight. The
  // profile is only awaited once retrieval has already produced candidates
  // (right before eligibility screening / LLM scoring, both of which genuinely
  // need it). One retrieval, not two: re-embedding after the profile resolves
  // would mean a SECOND embedding call plus a full re-rank before the user sees
  // anything, undoing the latency win for a quality gain that's usually small —
  // `profile.description` is normally a light rephrasing of the same raw text
  // (extractProfile mostly restates/structures it), so raw-description cosine +
  // BM25 already recovers nearly the same candidate set the profile-expanded
  // query would. The one signal this forgoes is `expandedTerms`/enrichment
  // vocabulary (e.g. mapping "sensors" -> "SBIR"); that's still applied, just
  // deferred to a rank REORDER (not a re-embed) once the profile is in, via the
  // existing `enrich` boost below — same effect, without blocking display.
  const profilePromise = d.extractProfile(description, meter, signal);
  // Attach a no-op rejection handler immediately so Node never logs an
  // "unhandled rejection" if extractProfile fails while retrieval (below) is
  // still in flight — the real error still surfaces at the `await
  // profilePromise` further down, which is a SEPARATE handler on the same
  // promise and rejects exactly as before.
  profilePromise.catch(() => {});

  // 3. Semantic expansion — embed the RAW description directly (sub-second).
  const queryText = description;
  const queryVec = await d.embed(queryText, meter, signal);
  // Fail loudly if the live query and the committed corpus don't share an
  // embedding space (switched EMBEDDINGS_MODEL without re-embedding) — otherwise
  // cosine() silently returns NaN for every opp and the run looks like a weak
  // field for no visible reason. Sampled from the first embedded opp (uniform dim).
  const corpusDim = d.corpus.find((o) => Array.isArray(o.embedding) && o.embedding.length > 0)?.embedding?.length;
  assertEmbeddingDimsMatch(queryVec.length, corpusDim);
  step({ key: "embed", label: `Searching ${d.corpus.length} programs`, pct: 15 });

  // 4. Hybrid retrieval: cosine similarity fused with a BM25 keyword rank, then
  //    LLM scoring. No pre-screen eligibility filter — every retrieved
  //    candidate is screened by screen() (C1).
  //
  // Hybrid fusion (instant-cards perf work): a keyword index over the SAME
  // corpus text (program/agency/description/eligibility — see
  // lib/retrieval/bm25.ts), fused with the cosine rank via reciprocal rank
  // fusion (lib/retrieval/hybrid.ts). This catches the case cosine alone
  // misses — a rare, highly specific keyword (a program acronym, a named
  // statute) that a general-purpose embedding under-weights. RRF only ever
  // RE-ORDERS candidates that already cleared the cosine floor below; a doc
  // below the floor is never promoted into candidacy by a keyword hit alone
  // (the floor is `sim`-only and stays that way — see the CALIBRATION note).
  // Indexing the corpus is lazy + cached by array identity (getBM25Index), so
  // a real request only pays the (sub-100ms) QUERY cost, not a rebuild.
  const bm25Index = getBM25Index(deps.corpus ?? getCorpus());
  const bm25Ids = new Set(d.corpus.map((o) => o.id));
  const bm25RankedIds = bm25Query(bm25Index, queryText)
    .map((h) => h.id)
    .filter((id) => bm25Ids.has(id));
  //
  // C1a (per-type retrieval quota): a single global top-`candidateCount` cosine
  // cut let the ~476 grants crowd out the ~492 non-grant opps (rd/SBIR,
  // procurement, assistance, loan, scholarship), so those instrument types
  // never reached the LLM scorer. We keep the global top-N unchanged (every
  // strong grant that already made the cut is preserved) and ADDITIONALLY
  // reserve the top `perTypeQuota` candidates of EACH `kind` present among the
  // floor-clearing set, unioning them in (deduped by id). This makes every
  // present instrument type REACHABLE by the scorer without displacing any
  // strong grant. Fully deterministic: stable sort, tie-broken by opp id, so
  // the union order is stable across runs.
  // `sim` is the RAW cosine — the ONLY thing the candidate floor gates, so
  // neither the enrichment boost (applied later, once the profile is in) nor
  // the BM25 fusion (applied immediately below) can ever admit a below-floor
  // opp. `floorCleared` is sorted by the cosine order first, then re-ordered
  // by the fused cosine+BM25 rank — ties (no BM25 signal at all, the common
  // case in a hermetic test corpus with no keyword overlap) fall back to the
  // exact original cosine order.
  const floorCleared = d.corpus
    .map((o) => {
      const sim = o.embedding ? cosine(queryVec, o.embedding) : 0;
      return { o, sim };
    })
    .filter((x) => x.sim >= CALIBRATION.candidateFloor)
    .sort((a, b) => b.sim - a.sim || (a.o.id < b.o.id ? -1 : a.o.id > b.o.id ? 1 : 0));

  const fusedOrder = fuseRankings(floorCleared.map((x) => x.o.id), bm25RankedIds);
  const byFusedRank = new Map(fusedOrder.map((id, i) => [id, i]));
  floorCleared.sort((a, b) => (byFusedRank.get(a.o.id) ?? 0) - (byFusedRank.get(b.o.id) ?? 0));

  // Base set: the UNCHANGED global top-N (preserves every strong grant that
  // already qualified — nothing is discarded to make room for the quota).
  const candidateCount = clampCandidateCount(maxCandidates);
  const selectedIds = new Set(floorCleared.slice(0, candidateCount).map((x) => x.o.id));

  // Reserved slots: top-`perTypeQuota`-by-cosine of EACH present kind, added if
  // not already selected. Because `floorCleared` is pre-sorted, taking the first
  // `perTypeQuota` occurrences per kind yields that kind's highest-cosine picks.
  const perKindTaken = new Map<string, number>();
  for (const x of floorCleared) {
    const taken = perKindTaken.get(x.o.kind) ?? 0;
    if (taken < CALIBRATION.perTypeQuota) {
      perKindTaken.set(x.o.kind, taken + 1);
      selectedIds.add(x.o.id);
    }
  }

  // The candidate slice sent to the scorer: the union, in the same deterministic
  // cosine-desc / id order as `floorCleared` (filter preserves array order).
  const scored = floorCleared.filter((x) => selectedIds.has(x.o.id));
  step({ key: "retrieve", label: `Found ${scored.length} candidate programs`, pct: 30 });

  // INSTANT CARDS — stream an unscored, provisional card for each retrieved
  // candidate right away, well before the (still in-flight, ~44s-on-local)
  // profile call resolves. The UI renders these with a spinner in place of a
  // score; a later "match" event for the same id upgrades the card in place.
  // Best-effort, in retrieval (fused-rank) order, capped at CARD_CAP-ish so a
  // huge candidateCount doesn't spam the client with cards that will never be
  // shown — the rest still arrive as ordinary "match" events once scored.
  for (const x of scored.slice(0, PROVISIONAL_PREVIEW_COUNT)) {
    try { onProvisional?.(x.o); } catch { /* progressive rendering is best-effort */ }
  }

  // Only now do we actually need the profile: eligibility screening, the B2
  // enrichment re-rank, and the LLM scorer's narrative context all require it.
  // It has been running in parallel with everything above since the top of
  // this function, so by the time a real (slow, local) run gets here it may
  // already be done — the ~44s is now hidden behind retrieval + the provisional
  // render instead of gating them.
  const { profile, followUps } = await profilePromise;
  step({ key: "profile", label: "Understood your company", pct: 45 });

  if (scored.length === 0) {
    step({ key: "weak", label: "Writing your finding…", pct: 80 });
    return weakField(profile, followUps, meter, d.explainWeakField, signal);
  }

  // B2 (profile-enriched ranking) — deterministic, flag-gated (default OFF).
  // Distills the structured StartupProfile fields (size, funding stage,
  // use-of-funds mechanism, industry/NAICS) into a non-negative re-rank boost.
  // Retrieval MEMBERSHIP was already decided above (cosine floor + fused
  // cosine/BM25 rank), before the profile existed; this only re-orders the
  // already-selected `scored` slice — same effect on which candidates the
  // scorer sees first as the pre-instant-cards behavior had on selection, just
  // decided a beat later so it never blocks the provisional render. When off,
  // `enrich` is undefined and `scored`'s order is untouched (the fused
  // cosine/BM25 order from retrieval).
  const enrich = isFlagEnabled("b2_enriched_ranking") ? deriveEnrichmentSignal(profile) : undefined;
  if (enrich) {
    scored.sort((a, b) => {
      const ra = a.sim + boostForOpportunity(enrich, a.o);
      const rb = b.sim + boostForOpportunity(enrich, b.o);
      return rb - ra || (a.o.id < b.o.id ? -1 : a.o.id > b.o.id ? 1 : 0);
    });
  }

  // Only a definitive, rule-based `excluded` skips the LLM; every other bucket is still scored.
  const companyProfile = toCompanyProfile(profile, companyFacts);
  const preExcluded: { o: Opportunity; determination: EligibilityDetermination }[] = [];
  const toScore: typeof scored = [];
  for (const x of scored) {
    try {
      const determination = d.screen(companyProfile, toScreenableOpportunity(x.o));
      if (determination.bucket === "excluded") {
        preExcluded.push({ o: x.o, determination });
        continue;
      }
    } catch {
      // Screening failed — score it normally; re-screened below.
    }
    toScore.push(x);
  }

  step({ key: "score", label: "Scoring and explaining your matches", pct: 52 });
  // Per-batch progress: interpolate between the score milestone (52) and the
  // assemble milestone (90) as batches settle. `detail` counts LLM work only
  // (SearchProgress extrapolates remaining time from it); two-pass `done` is
  // cost-weighted, so its label uses the real Pass A/B counts instead.
  const total = scored.length;
  const preDone = preExcluded.length;
  const emitScoreProgress = (doneInScoring: number, twoPass?: TwoPassProgressDetail) => {
    const done = preDone + doneInScoring;
    const pct = total > 0 ? 52 + Math.round((done / total) * 36) : 52;
    const scoredLabel = `Scored ${preDone + (twoPass ? twoPass.passAScored : doneInScoring)} of ${total} programs`;
    const label = twoPass?.promotedCount
      ? `${scoredLabel}, writing ${twoPass.passBScored} of ${twoPass.promotedCount} summaries`
      : scoredLabel;
    step({ key: "score-progress", label, pct, detail: `${doneInScoring}/${toScore.length}` });
  };
  const byId = new Map(scored.map((s) => [s.o.id, s.o]));
  // E3: two-pass is the default on local (a small model's per-candidate narrative is
  // too slow to run over every candidate); NEXT_PUBLIC_FLAG_E3_TWO_PASS=false opts out.
  // Hosted keeps the flag's default-off behavior.
  const useTwoPass = isLocalLlm() ? !isFlagExplicitlyDisabled("e3_two_pass") : isFlagEnabled("e3_two_pass");
  const candidatesToScore = toScore.map((s) => s.o);
  // Two-pass emits a narrated candidate twice (score-only, then narrative); the UI updates the card in place.
  const previewAssessment = (a: Assessment) => {
    const opp = byId.get(a.id);
    if (!opp) return;
    try { onMatch?.(baseMatchFromAssessment(a, opp, profile)); } catch { /* progressive rendering is best-effort */ }
  };
  const assessments: Assessment[] =
    candidatesToScore.length === 0
      ? []
      : useTwoPass
        ? await d.explainMatchesTwoPass(
            profile,
            candidatesToScore,
            meter,
            (done, _total, detail) => emitScoreProgress(done, detail),
            signal,
            previewAssessment,
          )
        : await d.explainMatches(
            profile,
            candidatesToScore,
            meter,
            (batchAssessments, done) => {
              emitScoreProgress(done);
              for (const a of batchAssessments) previewAssessment(a);
            },
            signal,
          );
  step({ key: "assemble", label: "Writing your opportunity map", pct: 90 });

  const allAssessments: Assessment[] = [
    ...assessments,
    ...preExcluded.map(({ o, determination }) => ({
      ...scoreOnlyAssessment(o.id, 0),
      whyIneligible: determination.failed_rules.map((r) => r.description).join(" "),
    })),
  ];

  const matches: Match[] = allAssessments
    .map((a) => {
      const opp = byId.get(a.id);
      return opp ? baseMatchFromAssessment(a, opp, profile) : null;
    })
    .filter(Boolean) as Match[];

  matches.sort((a, b) => b.score - a.score);

  // R8 / ELG-04: attach a REAL eligibility determination to each match. This is
  // cheap pure logic (no LLM, no network), so it always runs — no flag read here
  // (the flag gates only the DISPLAY, in OpportunityMap). The v1 profile is
  // bridged to the CompanyProfile screen() reads, mapping only genuinely-known
  // facts and leaving every unknown gate unset; per-opp rules are empty (the v1
  // corpus has only free-text eligibility), so the universal overlay drives the
  // buckets. DEFENSIVE: a screening error must NEVER break the search — each
  // screen() is wrapped, and a failure simply omits the field for that match.
  const preExcludedById = new Map(preExcluded.map((p) => [p.o.id, p.determination]));
  for (const m of matches) {
    const known = preExcludedById.get(m.opportunity.id);
    if (known) {
      m.eligibility = annotateFreshness(known);
      continue;
    }
    try {
      const determination = d.screen(companyProfile, toScreenableOpportunity(m.opportunity));
      m.eligibility = annotateFreshness(determination);
    } catch {
      // Screening failed for this one match — omit `eligibility`, keep going.
    }
  }
  step({ key: "eligibility", label: "Checking eligibility", pct: 94 });

  // DISCERNMENT (flag `discernment_layer`, default OFF): attach an ADVISORY
  // per-match verdict (recommend / verify / do_not_recommend) derived purely from
  // the score, the model's own met-criteria, and any USER-STATED disqualifier —
  // never a model-inferred exclusion (R8.4). When ON, "high potential" is recounted
  // as recommend-only and the honest-no is driven by a whole-map verdict. When OFF,
  // everything below is byte-unchanged.
  const discernment = isFlagEnabled("discernment_layer");
  if (discernment) {
    for (const m of matches) {
      m.recommendation = recommendFor({
        adjustedScore: m.score,
        kind: m.opportunity.kind,
        criteria: m.criteria,
        // Reserved for a user-STATED hard mismatch; the v1 profile/companyFacts
        // carry no structured ownership/size signal, so it is never set here — the
        // aggressive score/criteria floors do the discernment work.
        statedDisqualifier: false,
      });
    }
  }

  // "Strong" = the headline high-potential set. Under discernment that's the
  // matches we actually RECOMMEND; otherwise the legacy score>=scoreFloor set.
  const strong = discernment
    ? matches.filter((m) => m.recommendation?.recommendation === "recommend")
    : matches.filter((m) => m.score >= CALIBRATION.scoreFloor);
  const verifying = discernment
    ? matches.filter((m) => m.recommendation?.recommendation === "verify")
    : [];

  // Whole-map verdict (discernment only): decouples the honest-no from "zero clear
  // the floor" — one lucky marginal yields `thin_map` ("even our best is a
  // stretch"), not a confident list.
  const verdict = discernment
    ? mapVerdict({
        recommendCount: strong.length,
        verifyCount: verifying.length,
        maxScore: matches.reduce((mx, m) => Math.max(mx, m.score), 0),
      })
    : undefined;

  // 5. The honest no. Weak field is a finding, not an empty state. Under
  // discernment it fires on `no_fit` AND `thin_map` (§2 — "even our best is a
  // stretch" still gets a you-may-be-better-served-elsewhere note); otherwise the
  // legacy weakFieldThreshold drives it.
  // DEFENSIVE: this is an auxiliary narrative call — if it throws (429, timeout,
  // malformed JSON), degrade to omitting the finding rather than discarding the
  // entire computed `matches`/eligibility set. Mirrors the per-match screen()
  // wrapping above.
  const wantWeakField = discernment
    ? verdict === "no_fit" || verdict === "thin_map"
    : strong.length < CALIBRATION.weakFieldThreshold;
  let weak: Awaited<ReturnType<typeof d.explainWeakField>> | undefined;
  if (wantWeakField) {
    try {
      // F3 — back the model's redirects with a few real named Utah/SBA programs.
      weak = ensureRealRedirects(await d.explainWeakField(profile, meter, signal));
    } catch {
      weak = undefined;
    }
  }

  const now = Date.now();
  const in90 = matches.filter((m) => {
    const d = m.opportunity.deadline ? Date.parse(m.opportunity.deadline) : NaN;
    return !Number.isNaN(d) && d > now && d - now < 90 * 864e5;
  }).length;

  const agencies = Array.from(new Set(strong.map((m) => m.opportunity.agency)));

  const result: OpportunityMap = {
    // §3.6 — stamp the contract version on every live write so consumers can
    // branch on it later (the affordance was inert while producers never wrote it).
    version: CURRENT_OPPORTUNITY_MAP_VERSION,
    profile,
    followUps,
    summary: {
      // Under discernment, high-potential counts only RECOMMENDED matches (the
      // single biggest anti-over-generosity lever); `worthVerifying` keeps the
      // marginal set visible so nothing is hidden.
      highPotential: strong.length,
      ...(discernment ? { worthVerifying: verifying.length } : {}),
      fundingIdentified: strong.reduce((sum, m) => sum + (m.opportunity.fundingHigh ?? 0), 0),
      agencies: agencies.length,
      closingIn90Days: in90,
    },
    ...(verdict ? { mapVerdict: verdict } : {}),
    matches,
    weakFieldFinding: weak,
    agencyIntelligence: agencies.slice(0, 5).map((agency) => ({
      agency,
      why: strong.find((m) => m.opportunity.agency === agency)?.whyFit?.slice(0, 180) ?? "",
      opportunityCount: strong.filter((m) => m.opportunity.agency === agency).length,
    })),
  };
  finalizeCost(meter, result);
  return result;
}

async function weakField(
  profile: StartupProfile,
  followUps: string[],
  meter: CostMeter,
  explainWeak: typeof explainWeakField = explainWeakField,
  signal?: AbortSignal,
): Promise<OpportunityMap> {
  const result: OpportunityMap = {
    version: CURRENT_OPPORTUNITY_MAP_VERSION,
    profile,
    followUps,
    summary: { highPotential: 0, fundingIdentified: 0, agencies: 0, closingIn90Days: 0 },
    matches: [],
    // F3 — back the model's redirects with a few real named Utah/SBA programs.
    weakFieldFinding: ensureRealRedirects(await explainWeak(profile, meter, signal)),
    agencyIntelligence: [],
  };
  finalizeCost(meter, result);
  return result;
}
