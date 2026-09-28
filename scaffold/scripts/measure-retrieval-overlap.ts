/**
 * §3 — retrieval-quality report: candidate-set overlap between the real
 * `scored` set `buildOpportunityMap` sends to the LLM (via a capturing scorer
 * stub, so no LLM is actually called) and origin/main's retrieval (cosine +
 * per-type quota only, no BM25, no scored-set trim) for the 5 standard test
 * cases.
 *
 * Uses the real `extractProfile` and the local embedder configured in
 * .env.local; never calls the LLM scorer. Run with:
 *   npx tsx scripts/measure-retrieval-overlap.ts
 */
import "./_loadEnvLocal.mjs"; // honor scaffold/.env.local when run as plain `tsx`

import { embed, cosine } from "../lib/embed";
import { extractProfile } from "../lib/claude";
import { getCorpus } from "../lib/corpus/store";
import { dropExpiredOpportunities } from "../lib/corpus/expiry";
import { screen } from "../lib/eligibility/screen";
import { buildOpportunityMap, CALIBRATION, clampCandidateCount, type BuildDeps } from "../lib/match";
import type { Opportunity, StartupProfile, Tier } from "../lib/types";
import type { Assessment } from "../lib/claude";

const CASES: [string, string][] = [
  ["1 ai-healthcare", "We're a 15-person Utah company developing AI-powered software that helps hospitals reduce administrative work for nurses. We've raised $2.5M, have $1M in ARR, and are looking for $500K–$2M of non-dilutive capital to fund product development and hospital pilots."],
  ["2 manufacturing", "We're a 35-person Utah hardware startup doing advanced manufacturing for lightweight aerospace components. $3M in revenue, raised $8M, looking for $2M–$5M for manufacturing scale-up and R&D."],
  ["3 water", "We're a 10-person Utah startup with a sensor and AI platform that reduces municipal water loss. $500K revenue, raised $1.5M, seeking $500K–$3M for product development and municipal pilots."],
  ["4 cyber", "We're a 22-person Utah cybersecurity startup building AI-powered threat detection for small and mid-sized organizations. $2M ARR, raised $5M, seeking $1M–$3M for R&D and federal/commercial expansion."],
  ["5 marketplace", "We're an 8-person Utah technology startup running a marketplace connecting parents with local youth activities and enrichment programs. $750K revenue, raised $1M, looking for $250K–$1M for expansion and technology development."],
];

/** origin/main's own retrieval: cosine + per-type quota, no BM25, no trim. */
function mainRetrieval(corpus: Opportunity[], queryVec: number[], candidateCount: number): string[] {
  const floorCleared = corpus
    .map((o) => ({ o, sim: o.embedding ? cosine(queryVec, o.embedding) : 0 }))
    .filter((x) => x.sim >= CALIBRATION.candidateFloor)
    .sort((a, b) => b.sim - a.sim || (a.o.id < b.o.id ? -1 : a.o.id > b.o.id ? 1 : 0));

  const selectedIds = new Set(floorCleared.slice(0, candidateCount).map((x) => x.o.id));
  const perKindTaken = new Map<string, number>();
  for (const x of floorCleared) {
    const taken = perKindTaken.get(x.o.kind) ?? 0;
    if (taken < CALIBRATION.perTypeQuota) {
      perKindTaken.set(x.o.kind, taken + 1);
      selectedIds.add(x.o.id);
    }
  }
  return floorCleared.filter((x) => selectedIds.has(x.o.id)).map((x) => x.o.id);
}

function queryTextFor(profile: StartupProfile): string {
  return [
    profile.description,
    profile.technology,
    profile.industry,
    profile.rdActivities,
    profile.targetCustomers,
    (profile.expandedTerms ?? []).join(", "),
  ].filter(Boolean).join("\n");
}

function stubAssess(id: string): Assessment {
  return {
    id, score: 0, tier: "none" as Tier, criteria: [],
    whyCare: "", whyFit: "", whyIneligible: "", whatToVerify: "", whatToDoNext: "",
  };
}

/** Runs the real pipeline up to (and including) the scored-set trim, via a
 *  capturing scorer stub in place of both scorer entry points — whichever one
 *  `buildOpportunityMap` picks (two-pass on local, single-pass otherwise). */
async function capturedScoredSet(corpus: Opportunity[], description: string): Promise<string[]> {
  let captured: string[] = [];
  const deps: Partial<BuildDeps> = {
    corpus,
    screen,
    explainMatches: async (_p, candidates) => {
      captured = candidates.map((c) => c.id);
      return candidates.map((c) => stubAssess(c.id));
    },
    explainMatchesTwoPass: async (_p, candidates) => {
      captured = candidates.map((c) => c.id);
      return candidates.map((c) => stubAssess(c.id));
    },
    explainWeakField: async () => ({ headline: "h", reasoning: "r", redirects: [] }),
  };
  await buildOpportunityMap(description, undefined, deps);
  return captured;
}

async function main() {
  const corpus = dropExpiredOpportunities(getCorpus());
  const candidateCount = clampCandidateCount(undefined);

  console.log(`Corpus: ${corpus.length} opportunities. candidateCount=${candidateCount}\n`);

  for (const [id, description] of CASES) {
    const t0 = Date.now();
    const { profile } = await extractProfile(description, undefined, undefined);
    const queryVec = await embed(queryTextFor(profile), undefined, undefined);
    const mainIds = mainRetrieval(corpus, queryVec, candidateCount);
    const scoredIds = await capturedScoredSet(corpus, description);

    const mainSet = new Set(mainIds);
    const scoredSet = new Set(scoredIds);
    const intersection = scoredIds.filter((x) => mainSet.has(x));
    const union = new Set([...mainIds, ...scoredIds]);
    const jaccard = union.size > 0 ? intersection.length / union.size : 1;
    const mainOnly = mainIds.filter((x) => !scoredSet.has(x));

    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(
      `${id.padEnd(16)} main=${mainIds.length} scored=${scoredIds.length} overlap=${intersection.length} jaccard=${jaccard.toFixed(2)} main-only=${mainOnly.length} (${secs}s)`,
    );
    if (mainOnly.length > 0) console.log(`  evicted from main's own selection: ${mainOnly.join(", ")}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
