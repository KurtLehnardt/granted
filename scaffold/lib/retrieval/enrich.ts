import type { Opportunity, StartupProfile } from "../types";
import type { OpportunityKind } from "../contracts/opportunity";

/**
 * B2 — profile-enriched retrieval.
 *
 * Pure, dependency-light (no LLM, no embedding, no network) module that turns
 * the STRUCTURED fields the intake extractor already puts on a v1
 * `StartupProfile` — employee size, funding stage, use-of-funds, industry /
 * NAICS guesses — into two DETERMINISTIC retrieval signals:
 *
 *   1. `enrichmentQueryTerms(signal)` — extra government-vocabulary terms folded
 *      into the query-embedding text so size/stage/use-of-funds/NAICS sharpen the
 *      cosine retrieval itself (e.g. an R&D use-of-funds pulls in "SBIR"/"STTR").
 *
 *   2. `boostForOpportunity(signal, opp)` — a small, NON-NEGATIVE additive boost
 *      applied to a candidate's cosine similarity for RANKING / SELECTION only.
 *      It re-orders and re-selects among opps that ALREADY cleared the raw-cosine
 *      candidate floor; it can never pull a below-floor opp into candidacy, and
 *      it never touches the LLM score, the score floor, or the weak-field logic.
 *      Because it is non-negative it only ever PROMOTES a better-fitting
 *      mechanism/size/industry — it never demotes or excludes, so R8.4 ("never
 *      exclude on a model-inferred fact") and the sacred honest-no are both
 *      untouched.
 *
 * `lib/match.ts` reads both, gated behind the `b2_enriched_ranking` flag
 * (default OFF): with the flag off, `deriveEnrichmentSignal` is never called,
 * the query text and ranking are byte-for-byte the pre-B2 behavior, and the
 * calibration/quota guarantees hold unchanged.
 */

/** The distilled, deterministic retrieval signal derived from a profile. */
export interface EnrichmentSignal {
  /** Instrument kinds the funding stage / use-of-funds point at. */
  mechanisms: Set<OpportunityKind>;
  /**
   * `true` when a stated headcount lands at/under the SBA/SBIR 500 cap,
   * `false` when it is clearly over, `undefined` when unknown. Only ever used
   * to PROMOTE small-business instruments — never to exclude (R8.4).
   */
  smallBusiness: boolean | undefined;
  /** Lowercased industry / NAICS tokens used to match an opp's `industryTags`. */
  industryTokens: string[];
  /** Government-vocabulary terms to append to the query-embedding text. */
  queryTerms: string[];
}

/** SBA / SBIR small-business size standard (employees, with affiliates). */
export const SMALL_BUSINESS_EMPLOYEE_CAP = 500;

// Boost magnitudes. Deliberately small relative to the cosine range so
// enrichment re-orders near-ties and sharpens selection without scrambling a
// genuinely stronger semantic match. Each is additive and NON-NEGATIVE.
export const MECHANISM_BOOST = 0.06;
export const SIZE_BOOST = 0.03;
export const INDUSTRY_BOOST = 0.04;

/** Keyword → instrument-kind map for the use-of-funds / stage → mechanism read. */
const MECHANISM_KEYWORDS: ReadonlyArray<{ kind: OpportunityKind; terms: readonly string[] }> = [
  {
    kind: "rd",
    terms: [
      "research", "r&d", "r & d", "rnd", "prototype", "sbir", "sttr",
      "proof of concept", "technology development", "develop technology",
      "product development", "experimental", "innovation", "commercialization of research",
    ],
  },
  {
    kind: "loan",
    terms: [
      "loan", "working capital", "equipment", "machinery", "facility",
      "real estate", "expansion", "inventory", "refinanc", "build out",
      "buildout", "purchase a building", "capital expenditure",
    ],
  },
  {
    kind: "procurement",
    terms: [
      "contract", "procure", "procurement", "sell to the government",
      "sell to government", "government customer", "government as a customer",
      "supply", "deliver goods", "gsa schedule", "federal contract",
    ],
  },
  {
    kind: "scholarship",
    terms: ["scholarship", "fellowship", "tuition", "stipend", "student support"],
  },
];

/** Government-vocabulary terms emitted per mechanism (feeds the embedding). */
const MECHANISM_QUERY_TERMS: Readonly<Record<OpportunityKind, readonly string[]>> = {
  grant: ["federal grant", "grant funding"],
  rd: ["SBIR", "STTR", "research and development", "R&D contract"],
  assistance: ["technical assistance", "assistance listing"],
  procurement: ["federal contract", "government procurement", "GSA schedule"],
  loan: ["loan guarantee", "working capital", "SBA loan"],
  scholarship: ["scholarship", "fellowship"],
};

function lc(s: string | undefined): string {
  return (s ?? "").toLowerCase();
}

/** Split a free-text / code field into lowercased, de-noised tokens. */
function tokenize(values: Array<string | undefined>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of values) {
    if (!raw) continue;
    for (const tok of raw.toLowerCase().split(/[^a-z0-9]+/)) {
      const t = tok.trim();
      // Drop empties and low-signal stopword-ish short tokens.
      if (t.length < 3) continue;
      if (seen.has(t)) continue;
      seen.add(t);
      out.push(t);
    }
  }
  return out;
}

/**
 * Derive the deterministic enrichment signal from a v1 `StartupProfile`.
 * Reads only the structured fields the extractor populates; missing fields
 * simply contribute nothing (no signal, no boost).
 */
export function deriveEnrichmentSignal(profile: StartupProfile): EnrichmentSignal {
  const mechanismText = [
    lc(profile.useOfFunds),
    lc(profile.fundingStage),
    lc(profile.rdActivities),
    lc(profile.capitalRequirement),
  ].join(" ");

  const mechanisms = new Set<OpportunityKind>();
  for (const { kind, terms } of MECHANISM_KEYWORDS) {
    if (terms.some((t) => mechanismText.includes(t))) mechanisms.add(kind);
  }

  // Early-stage applicants (idea/pre-seed/seed) with an R&D use-of-funds are the
  // canonical SBIR/STTR population — nudge the rd mechanism in for them even if
  // the use-of-funds prose didn't name it outright.
  const stage = lc(profile.fundingStage);
  if (/\b(idea|pre[-_ ]?seed|seed)\b/.test(stage) && /research|develop|prototype|technolog/.test(mechanismText)) {
    mechanisms.add("rd");
  }

  const smallBusiness =
    typeof profile.employees === "number"
      ? profile.employees <= SMALL_BUSINESS_EMPLOYEE_CAP
      : undefined;

  const industryTokens = tokenize([
    profile.industry,
    ...(profile.naicsGuesses ?? []),
  ]);

  return {
    mechanisms,
    smallBusiness,
    industryTokens,
    queryTerms: buildQueryTerms(mechanisms, smallBusiness),
  };
}

function buildQueryTerms(mechanisms: Set<OpportunityKind>, smallBusiness: boolean | undefined): string[] {
  const terms: string[] = [];
  // Iterate in canonical order (not Set-insertion order) for a stable, tsc-target-
  // agnostic emit — avoids for-of over a Set (needs downlevelIteration here).
  for (const kind of Array.from(mechanisms)) {
    for (const t of MECHANISM_QUERY_TERMS[kind]) terms.push(t);
  }
  if (smallBusiness === true) terms.push("small business");
  // De-dupe, preserve first-seen order for determinism.
  return Array.from(new Set(terms));
}

/**
 * The government-vocabulary terms to fold into the query-embedding text.
 * Returns `[]` when the profile carried no structured routing signal.
 */
export function enrichmentQueryTerms(signal: EnrichmentSignal): string[] {
  return signal.queryTerms;
}

/** Does the opp's `industryTags` overlap the profile's industry/NAICS tokens? */
function industryMatches(signal: EnrichmentSignal, opp: Opportunity): boolean {
  if (signal.industryTokens.length === 0) return false;
  const tags = opp.industryTags;
  if (!tags || tags.length === 0) return false;
  const tagTokens = tokenize(tags);
  return tagTokens.some((t) => signal.industryTokens.includes(t));
}

/**
 * A deterministic, NON-NEGATIVE ranking boost for a single candidate.
 *
 * Combines three independent signals (each additive, capped implicitly by how
 * many can fire):
 *   - mechanism: the opp's `kind` is one the funding stage / use-of-funds
 *     pointed at (grant vs rd/SBIR vs loan vs procurement …);
 *   - size: a small-business-eligible headcount promotes SBIR/rd instruments;
 *   - industry: the opp's `industryTags` overlap the profile's industry/NAICS.
 *
 * Never negative — enrichment only ever promotes a better mechanism/size/
 * industry fit, so it can neither push a candidate below the floor nor act as
 * an eligibility exclusion.
 */
export function boostForOpportunity(signal: EnrichmentSignal, opp: Opportunity): number {
  let boost = 0;
  if (signal.mechanisms.has(opp.kind)) boost += MECHANISM_BOOST;
  if (signal.smallBusiness === true && (opp.kind === "rd" || opp.source === "sbir")) {
    boost += SIZE_BOOST;
  }
  if (industryMatches(signal, opp)) boost += INDUSTRY_BOOST;
  return boost;
}
