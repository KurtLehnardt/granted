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
  /** Retrieval quality fix — BM25 no longer re-orders the cosine+quota
   *  selection (that let a whole-corpus keyword ranking, over ~20 expandedTerms,
   *  bump ~55% of the cosine set out, including top-cosine candidates). BM25
   *  now only ADDS a handful of floor-clearing, keyword-strong ids the cosine
   *  cut missed — it can never displace a candidate cosine+quota already picked. */
  bm25SupplementCount: 4,
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
    // ANALYZING ring (§5): `final` marks whether this score can still change.
    // Absent from most assessment producers (single-pass explainMatches, a
    // pre-excluded determination) — those are always terminal, so default true.
    // Two-pass Pass-A events explicitly set it false for a promoted candidate
    // still awaiting its Pass-B narrative.
    final: a.final ?? true,
    unscored: a.unscored ?? false,
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

  // INSTANT CARDS — profile extraction (the ~44s local-LLM call that used to
  // gate everything else) runs IN PARALLEL with an immediate, raw-description
  // retrieval below. That first retrieval only needs an EMBEDDING of the raw
  // description (sub-second even on a local embedding model), so a provisional
  // candidate set streams to the client well before the profile resolves. Once
  // the profile IS in, retrieval is re-run properly — profile-based query text
  // (including `expandedTerms`), exactly as it was before this feature — and
  // THAT re-run set (unioned with whatever provisional ids are already on
  // screen) is what actually gets scored. So the raw-description pass only
  // ever decides what's shown instantly; it never substitutes for the
  // profile-based retrieval that determines scoring.
  const profilePromise = d.extractProfile(description, meter, signal);
  // Attach a no-op rejection handler immediately so Node never logs an
  // "unhandled rejection" if extractProfile fails while retrieval (below) is
  // still in flight — the real error still surfaces at the `await
  // profilePromise` further down, which is a SEPARATE handler on the same
  // promise and rejects exactly as before.
  profilePromise.catch(() => {});

  // Shared retrieval helper: cosine-floor + C1a per-type quota selection
  // (byte-for-byte the pre-hybrid, origin/main algorithm — optionally
  // re-ranked by the B2 enrichment boost, exactly as main did), plus a small
  // BM25 supplement, over whatever query text/vector is passed in. Used twice
  // — once instantly on the raw description (below), and again once the
  // profile resolves (further down) — so both passes share one implementation.
  const bm25Index = getBM25Index(deps.corpus ?? getCorpus());
  const bm25Ids = new Set(d.corpus.map((o) => o.id));
  function retrieve(queryVec: number[], queryText: string, enrich?: ReturnType<typeof deriveEnrichmentSignal>) {
    // `sim` is the RAW cosine — the ONLY thing the candidate floor gates.
    // `rank` additionally folds in the B2 boost (0 when the flag is off /
    // no profile yet), and is what the top-N cut and per-type quota below
    // sort by — main's exact selection algorithm, so a strong cosine (or
    // B2-boosted) candidate can never be displaced by BM25.
    const floorCleared = d.corpus
      .map((o) => {
        const sim = o.embedding ? cosine(queryVec, o.embedding) : 0;
        const rank = enrich ? sim + boostForOpportunity(enrich, o) : sim;
        return { o, sim, rank };
      })
      .filter((x) => x.sim >= CALIBRATION.candidateFloor)
      .sort((a, b) => b.rank - a.rank || (a.o.id < b.o.id ? -1 : a.o.id > b.o.id ? 1 : 0));

    // C1a (per-type retrieval quota): a single global top-`candidateCount`
    // cosine cut let the ~476 grants crowd out the ~492 non-grant opps
    // (rd/SBIR, procurement, assistance, loan, scholarship), so those
    // instrument types never reached the LLM scorer. We keep the global
    // top-N unchanged (every strong grant that already qualified is
    // preserved) and ADDITIONALLY reserve the top `perTypeQuota` candidates
    // of EACH `kind` present among the floor-clearing set, unioning them in.
    const candidateCount = clampCandidateCount(maxCandidates);
    const selectedIds = new Set(floorCleared.slice(0, candidateCount).map((x) => x.o.id));
    const perKindTaken = new Map<string, number>();
    for (const x of floorCleared) {
      const taken = perKindTaken.get(x.o.kind) ?? 0;
      if (taken < CALIBRATION.perTypeQuota) {
        perKindTaken.set(x.o.kind, taken + 1);
        selectedIds.add(x.o.id);
      }
    }

    // BM25 supplement: union in up to `bm25SupplementCount` floor-clearing,
    // keyword-strong ids the cosine+quota selection above missed. Purely
    // additive — it can only grow the selected set, never re-order or evict
    // anything already selected by cosine/B2 above.
    const floorClearedIds = new Set(floorCleared.map((x) => x.o.id));
    const bm25RankedIds = bm25Query(bm25Index, queryText)
      .map((h) => h.id)
      .filter((id) => bm25Ids.has(id));
    let bm25Added = 0;
    for (const id of bm25RankedIds) {
      if (bm25Added >= CALIBRATION.bm25SupplementCount) break;
      if (!floorClearedIds.has(id) || selectedIds.has(id)) continue;
      selectedIds.add(id);
      bm25Added++;
    }

    return floorCleared.filter((x) => selectedIds.has(x.o.id));
  }

  // 3. Instant retrieval — embed the RAW description directly (sub-second),
  //    so a provisional candidate set can stream before the profile resolves.
  const rawQueryVec = await d.embed(description, meter, signal);
  // Fail loudly if the live query and the committed corpus don't share an
  // embedding space (switched EMBEDDINGS_MODEL without re-embedding) — otherwise
  // cosine() silently returns NaN for every opp and the run looks like a weak
  // field for no visible reason. Sampled from the first embedded opp (uniform dim).
  const corpusDim = d.corpus.find((o) => Array.isArray(o.embedding) && o.embedding.length > 0)?.embedding?.length;
  assertEmbeddingDimsMatch(rawQueryVec.length, corpusDim);
  step({ key: "embed", label: `Searching ${d.corpus.length} programs`, pct: 15 });

  const provisionalScored = retrieve(rawQueryVec, description);
  step({ key: "retrieve", label: `Found ${provisionalScored.length} candidate programs`, pct: 30 });

  // INSTANT CARDS — stream an unscored, provisional card for each retrieved
  // candidate right away, well before the (still in-flight, ~44s-on-local)
  // profile call resolves. The UI renders these with a spinner in place of a
  // score; a later "match" event for the same id upgrades the card in place.
  // Best-effort, in retrieval (cosine-rank) order, capped at CARD_CAP-ish so a
  // huge candidateCount doesn't spam the client with cards that will never be
  // shown. Every id shown here is guaranteed a terminal event later (see the
  // "resolve every provisional id" step below), regardless of what the
  // profile-based retrieval re-run below decides.
  const provisionalIds = new Set(provisionalScored.slice(0, PROVISIONAL_PREVIEW_COUNT).map((x) => x.o.id));
  for (const x of provisionalScored) {
    if (!provisionalIds.has(x.o.id)) continue;
    try { onProvisional?.(x.o); } catch { /* progressive rendering is best-effort */ }
  }

  // Only now do we actually need the profile: eligibility screening, the
  // profile-based retrieval re-run, and the LLM scorer's narrative context all
  // require it. It has been running in parallel with everything above since
  // the top of this function, so by the time a real (slow, local) run gets
  // here it may already be done — the ~44s is now hidden behind retrieval +
  // the provisional render instead of gating them.
  const { profile, followUps } = await profilePromise;
  step({ key: "profile", label: "Understood your company", pct: 45 });

  // B2 (profile-enriched ranking) — deterministic, flag-gated (default OFF).
  // Distills the structured StartupProfile fields (size, funding stage,
  // use-of-funds mechanism, industry/NAICS) into government-vocabulary query
  // terms folded into the re-embed below, plus a non-negative re-rank boost.
  const enrich = isFlagEnabled("b2_enriched_ranking") ? deriveEnrichmentSignal(profile) : undefined;

  // 4. Real retrieval — re-run exactly as before this feature existed: embed
  //    the PROFILE (not the raw description), so `expandedTerms` and the other
  //    structured fields the extractor produced actually shape retrieval, and
  //    the same B2-boosted cosine+quota selection main always used decides
  //    the candidate set. BM25 (the instant-cards hybrid-retrieval addition)
  //    only supplements it — see `retrieve()`. This is the set that actually
  //    gets scored.
  const queryText = [
    profile.description,
    profile.technology,
    profile.industry,
    profile.rdActivities,
    profile.targetCustomers,
    (profile.expandedTerms ?? []).join(", "),
    enrich ? enrichmentQueryTerms(enrich).join(", ") : "",
  ].filter(Boolean).join("\n");
  const queryVec = await d.embed(queryText, meter, signal);
  assertEmbeddingDimsMatch(queryVec.length, corpusDim);
  const profileScored = retrieve(queryVec, queryText, enrich);

  // Final candidate set = the profile-based retrieval UNION every provisional
  // id already shown to the user, so none of them can go unscored just because
  // the profile-based re-run ranked them out — but capped at the profile set's
  // own size (matching what main would have sent to the scorer), by trimming
  // the lowest-ranked profile-set members to make room. Without this, a run
  // where the raw-description pass and the profile-based pass disagree a lot
  // scores noticeably more candidates than main did, overshooting the
  // Settings maxCandidates value and its local-LLM time estimate.
  const profileScoredIds = new Set(profileScored.map((x) => x.o.id));
  const provisionalOnlyExtras = provisionalScored.filter(
    (x) => provisionalIds.has(x.o.id) && !profileScoredIds.has(x.o.id),
  );
  const trimCount = Math.min(provisionalOnlyExtras.length, profileScored.length);
  const scored = [
    ...(trimCount > 0 ? profileScored.slice(0, profileScored.length - trimCount) : profileScored),
    ...provisionalOnlyExtras,
  ];

  if (scored.length === 0) {
    step({ key: "weak", label: "Writing your finding…", pct: 80 });
    return weakField(profile, followUps, meter, d.explainWeakField, signal);
  }

  // RESOLVE EVERY PROVISIONAL ID (§1): tracks every id that has already had a
  // TERMINAL ("final: true") match event streamed via onMatch, regardless of
  // whether that id also ends up in the authoritative `matches` array below —
  // `matches` presence and "was actually streamed" are different questions
  // (e.g. Pass A can drop an id from its own callbacks entirely while
  // `assembleTwoPass` still gives it an `unscored` assessment that lands in
  // `matches` without ever having been streamed). Checked against `matches`
  // membership, the reconciliation loop further down mistook "will appear in
  // the final map" for "the client was told," so a provisional card spun
  // forever even though its id was technically resolved by the time this
  // function returned.
  const streamedFinalIds = new Set<string>();

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

  // A pre-excluded candidate never reaches the scorer at all, so — unlike a
  // scored candidate — it would otherwise get NO event until this whole
  // function returns, minutes later on local. Stream its terminal match right
  // now, immediately after screening decided it, instead of leaving its card
  // spinning through the entire scoring phase for no reason.
  for (const { o, determination } of preExcluded) {
    const assessment = {
      ...scoreOnlyAssessment(o.id, 0),
      whyIneligible: determination.failed_rules.map((r) => r.description).join(" "),
    };
    streamedFinalIds.add(o.id);
    try { onMatch?.(baseMatchFromAssessment(assessment, o, profile)); } catch { /* progressive rendering is best-effort */ }
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
  // `final` (defaulting true — see baseMatchFromAssessment) is the terminal
  // signal: mark it streamed as soon as it goes out, so the "resolve every
  // provisional id" reconciliation below never re-sends (or worse, thinks
  // still-pending) an id whose real terminal event the client already got.
  const previewAssessment = (a: Assessment) => {
    const opp = byId.get(a.id);
    if (!opp) return;
    if (a.final ?? true) streamedFinalIds.add(a.id);
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

  // RESOLVE EVERY PROVISIONAL ID (§1): a spinner card must never spin forever.
  // Checked against `streamedFinalIds` (what the client was actually SENT), not
  // presence in `matches` (what the final map happens to CONTAIN) — those two
  // differ whenever an assessment lands in `matches` without ever having been
  // streamed, e.g. `assembleTwoPass` giving a Pass-A-dropped id an `unscored`
  // assessment that no `onAssessment` call ever fired for. Whatever the cause
  // (a dropped/misnamed id, a hosted batch failing outright, a pre-excluded
  // candidate, the model returning an unknown id), every id shown as a
  // provisional card gets an explicit terminal event and a place in the final
  // map: an honest "couldn't score" placeholder or its existing match,
  // re-sent, never a silent drop.
  const matchByOppId = new Map(matches.map((m) => [m.opportunity.id, m]));
  for (const id of Array.from(provisionalIds)) {
    if (streamedFinalIds.has(id)) continue;
    let resolved = matchByOppId.get(id);
    if (!resolved) {
      const opp = byId.get(id);
      if (!opp) continue;
      resolved = {
        opportunity: opp,
        tier: "none",
        score: 0,
        criteria: [],
        whyCare: "",
        whyFit: "",
        whyIneligible: "",
        whatToVerify: "",
        whatToDoNext: "",
        history: historyFor(opp.id, profile.location),
        final: true,
        unscored: true,
      };
      matches.push(resolved);
      matchByOppId.set(id, resolved);
    }
    try { onMatch?.(resolved); } catch { /* progressive rendering is best-effort */ }
    streamedFinalIds.add(id);
  }

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
