import { embed, cosine } from "./embed";
import { extractProfile, explainMatches, explainMatchesTwoPass, explainWeakField } from "./claude";
import type { Opportunity, OpportunityMap, StartupProfile, Match, Tier, AwardHistory } from "./types";
import { screen } from "./eligibility/screen";
import { annotateFreshness } from "./eligibility/freshness";
import { toCompanyProfile, toScreenableOpportunity, type KnownCompanyFacts } from "./eligibility/bridge";
import corpus from "@/data/opportunities.json";
import awards from "@/data/awards.json";
import { createCostMeter, type CostMeter } from "./metering/meter";
import { CURRENT_OPPORTUNITY_MAP_VERSION } from "./contracts/opportunityMap";
import { isFlagEnabled } from "./flags";
import { recommendFor, mapVerdict } from "./recommend";
// F3 — weak-field redirects should name a few REAL Utah/SBA programs, not just
// categories. Wrapped around both explainWeakField() call sites below (the
// zero-candidate weakField() branch and the below-threshold branch in
// buildOpportunityMap); see lib/redirects/utahSbaPrograms.ts for the curated
// list and the (pure, hermetic) guarantee it makes.
import { ensureRealRedirects } from "./redirects/utahSbaPrograms";
import { deriveEnrichmentSignal, enrichmentQueryTerms, boostForOpportunity } from "./retrieval/enrich";

/**
 * CALIBRATION KNOBS — tune these against all five test cases before touching UI.
 * Too aggressive and cases 1-4 under-match. Too loose and case 5 hallucinates.
 *
 * SOURCE OF TRUTH for these values + their audit trail:
 * `docs/calibration-baseline.md` (see its "CURRENT SHIPPED CALIBRATION"
 * section). If you change a knob here, update that doc in the SAME commit — the
 * baseline's older guidance is explicitly superseded there. A full golden-set
 * re-validation (evals/golden-set.jsonl) remains the outstanding audit step.
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
   *  tension the task anticipated: keep case-5 honest, do not over-fit case-1.
   *  See docs/calibration-baseline.md for the per-case audit. */
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

const REAL_DEPS: BuildDeps = {
  extractProfile,
  embed,
  explainMatches,
  explainMatchesTwoPass,
  explainWeakField,
  screen,
  corpus: corpus as unknown as Opportunity[],
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

export async function buildOpportunityMap(
  description: string,
  onStep?: (e: StepEvent) => void,
  deps: Partial<BuildDeps> = {},
  signal?: AbortSignal,
  companyFacts?: KnownCompanyFacts,
): Promise<OpportunityMap> {
  const d: BuildDeps = { ...REAL_DEPS, ...deps };
  // Progress is best-effort: a reporting error must never fail the search.
  const step = (e: StepEvent) => { try { onStep?.(e); } catch { /* ignore */ } };
  step({ key: "start", label: "Reading the federal register…", pct: 5 });

  // R4b — one CostMeter per search, threaded through every LLM/embedding
  // call below (including the weakField() early-exit path). Every method on
  // it is internally defensive and never throws (lib/metering/meter.ts).
  const meter = createCostMeter();

  // 1 + 2. Intake and adaptive follow-ups.
  const { profile, followUps } = await d.extractProfile(description, meter, signal);
  step({ key: "profile", label: "Understood your company", pct: 18 });

  // B2 (profile-enriched ranking) — deterministic, flag-gated (default OFF).
  // When on, distill the structured StartupProfile fields (size, funding stage,
  // use-of-funds mechanism, industry/NAICS) into a retrieval signal that (a)
  // folds government-vocabulary terms into the query-embedding text below and
  // (b) drives a non-negative re-rank boost over the floor-clearing candidates.
  // When off, `enrich` is undefined and every line below is byte-for-byte the
  // pre-B2 behavior, so the calibration/quota guarantees hold unchanged.
  const enrich = isFlagEnabled("b2_enriched_ranking") ? deriveEnrichmentSignal(profile) : undefined;

  // 3. Semantic expansion — embed the founder profile plus expanded gov terms
  //    (and, under B2, the enrichment-derived mechanism/size vocabulary).
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
  step({ key: "embed", label: `Searching ${d.corpus.length} programs`, pct: 32 });

  // 4. Hybrid retrieval: similarity, then LLM scoring. No pre-screen eligibility
  //    filter — every retrieved candidate is screened by screen() (C1).
  //
  // C1a (per-type retrieval quota): a single global top-`candidateCount` cosine
  // cut let the ~476 grants crowd out the ~492 non-grant opps (rd/SBIR,
  // procurement, assistance, loan, scholarship), so those instrument types
  // never reached the LLM scorer. We keep the global top-N unchanged (every
  // strong grant that already made the cut is preserved) and ADDITIONALLY
  // reserve the top `perTypeQuota` candidates of EACH `kind` present among the
  // floor-clearing set, unioning them in (deduped by id). This makes every
  // present instrument type REACHABLE by the scorer without displacing any
  // strong grant. Fully deterministic: stable sort by cosine desc, tie-broken
  // by opp id, so the union order is stable across runs.
  // B2: `sim` is the RAW cosine (still the ONLY thing the candidate floor gates,
  // so enrichment can never admit a below-floor opp); `rank` is `sim` plus the
  // deterministic non-negative enrichment boost (0 when the flag is off). Sorting
  // by `rank` re-orders and re-selects among floor-clearers only.
  const floorCleared = d.corpus
    .map((o) => {
      const sim = o.embedding ? cosine(queryVec, o.embedding) : 0;
      const rank = enrich ? sim + boostForOpportunity(enrich, o) : sim;
      return { o, sim, rank };
    })
    .filter((x) => x.sim >= CALIBRATION.candidateFloor)
    .sort((a, b) => (b.rank - a.rank) || (a.o.id < b.o.id ? -1 : a.o.id > b.o.id ? 1 : 0));

  // Base set: the UNCHANGED global top-N (preserves every strong grant that
  // already qualified — nothing is discarded to make room for the quota).
  const selectedIds = new Set(floorCleared.slice(0, CALIBRATION.candidateCount).map((x) => x.o.id));

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
  step({ key: "retrieve", label: `Found ${scored.length} candidate programs`, pct: 46 });

  if (scored.length === 0) {
    step({ key: "weak", label: "Writing your finding…", pct: 80 });
    return weakField(profile, followUps, meter, d.explainWeakField, signal);
  }

  step({ key: "score", label: "Scoring and explaining your matches", pct: 52 });
  // Per-batch progress: interpolate between the score milestone (52) and the
  // assemble milestone (90) as batches settle, so the ~83s scoring stage no
  // longer sits frozen at 52%.
  const onScoreBatch = (done: number, total: number) => {
    const pct = total > 0 ? 52 + Math.round((done / total) * 36) : 52;
    step({ key: "score-progress", label: `Scored ${done} of ${total} programs`, pct, detail: `${done}/${total}` });
  };
  // E3 (flag `e3_two_pass`, default OFF): when ON, run the cheap-then-narrative
  // two-pass scorer (Pass A scores all candidates on the cheap model; Pass B
  // writes full narratives only for those clearing the render threshold). When
  // OFF, the single-pass `explainMatches` runs exactly as before — identical
  // args, byte-unchanged behavior. Both return the same `Assessment[]` shape, so
  // everything below (tiering, eligibility, summary) is untouched.
  const assessments = isFlagEnabled("e3_two_pass")
    ? await d.explainMatchesTwoPass(profile, scored.map((s) => s.o), meter, onScoreBatch, signal)
    : await d.explainMatches(profile, scored.map((s) => s.o), meter, onScoreBatch, signal);
  step({ key: "assemble", label: "Writing your opportunity map", pct: 90 });
  const byId = new Map(scored.map((s) => [s.o.id, s.o]));

  const matches: Match[] = assessments
    .map((a) => {
      const opp = byId.get(a.id);
      if (!opp) return null;
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
      } as Match;
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
  const companyProfile = toCompanyProfile(profile, companyFacts);
  for (const m of matches) {
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
  // the score, the model's own met-criteria, and any FOUNDER-STATED disqualifier —
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
        // Reserved for a founder-STATED hard mismatch; the v1 profile/companyFacts
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
      why: strong.find((m) => m.opportunity.agency === agency)?.whyFit.slice(0, 180) ?? "",
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
