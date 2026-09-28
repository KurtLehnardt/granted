/**
 * §3 — retrieval-quality report: candidate-set overlap between this branch's
 * profile-based retrieval (cosine + quota, BM25 as a pure ADDITIVE supplement)
 * and origin/main's retrieval (cosine + per-type quota only, no BM25) for the
 * 5 standard test cases.
 *
 * Computes retrieval ONLY — embeds via the local Ollama embedder configured
 * in .env.local, calls extractProfile once per case (needed for the real
 * profile fields / expandedTerms both retrievals read), and never calls the
 * LLM scorer. Run with: npx tsx scripts/measure-retrieval-overlap.ts
 */
import "./_loadEnvLocal.mjs"; // honor scaffold/.env.local when run as plain `tsx`

import { embed, cosine } from "../lib/embed";
import { extractProfile } from "../lib/claude";
import { getCorpus } from "../lib/corpus/store";
import { getBM25Index, bm25Query } from "../lib/retrieval/bm25";
import { CALIBRATION, clampCandidateCount } from "../lib/match";
import type { Opportunity, StartupProfile } from "../lib/types";

const CASES: [string, string][] = [
  ["1 ai-healthcare", "We're a 15-person Utah company developing AI-powered software that helps hospitals reduce administrative work for nurses. We've raised $2.5M, have $1M in ARR, and are looking for $500K–$2M of non-dilutive capital to fund product development and hospital pilots."],
  ["2 manufacturing", "We're a 35-person Utah hardware startup doing advanced manufacturing for lightweight aerospace components. $3M in revenue, raised $8M, looking for $2M–$5M for manufacturing scale-up and R&D."],
  ["3 water", "We're a 10-person Utah startup with a sensor and AI platform that reduces municipal water loss. $500K revenue, raised $1.5M, seeking $500K–$3M for product development and municipal pilots."],
  ["4 cyber", "We're a 22-person Utah cybersecurity startup building AI-powered threat detection for small and mid-sized organizations. $2M ARR, raised $5M, seeking $1M–$3M for R&D and federal/commercial expansion."],
  ["5 marketplace", "We're an 8-person Utah technology startup running a marketplace connecting parents with local youth activities and enrichment programs. $750K revenue, raised $1M, looking for $250K–$1M for expansion and technology development."],
];

/** Mirrors `lib/match.ts`'s `retrieve()`: cosine+quota decides the base
 *  selection (byte-for-byte main's algorithm); BM25 (when `supplementIds` is
 *  passed) only ADDS floor-clearing ids the base selection missed, up to
 *  `CALIBRATION.bm25SupplementCount` — it never reorders or evicts. */
function topNByQuota(corpus: Opportunity[], queryVec: number[], candidateCount: number, supplementIds?: string[]) {
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

  if (supplementIds) {
    const floorClearedIds = new Set(floorCleared.map((x) => x.o.id));
    let added = 0;
    for (const id of supplementIds) {
      if (added >= CALIBRATION.bm25SupplementCount) break;
      if (!floorClearedIds.has(id) || selectedIds.has(id)) continue;
      selectedIds.add(id);
      added++;
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

async function main() {
  const corpus = getCorpus();
  const candidateCount = clampCandidateCount(undefined);
  const bm25Index = getBM25Index(corpus);

  console.log(`Corpus: ${corpus.length} opportunities. candidateCount=${candidateCount}\n`);

  for (const [id, description] of CASES) {
    const t0 = Date.now();
    const { profile } = await extractProfile(description, undefined, undefined);
    const queryText = queryTextFor(profile);
    const queryVec = await embed(queryText, undefined, undefined);

    // origin/main: cosine + quota, no BM25.
    const mainIds = topNByQuota(corpus, queryVec, candidateCount);

    // this branch: cosine + BM25 fusion (over the same profile-based query text) + quota.
    const bm25RankedIds = bm25Query(bm25Index, queryText).map((h) => h.id);
    const branchIds = topNByQuota(corpus, queryVec, candidateCount, bm25RankedIds);

    const mainSet = new Set(mainIds);
    const branchSet = new Set(branchIds);
    const intersection = branchIds.filter((x) => mainSet.has(x));
    const union = new Set([...mainIds, ...branchIds]);
    const jaccard = union.size > 0 ? intersection.length / union.size : 1;

    // The quality-critical metric: of main's own top-8-by-cosine, how many
    // does this branch's selection still include? BM25-as-supplement should
    // keep this at (or very near) 8/8 every time, since it can only add.
    const top8ByCosine = corpus
      .map((o) => ({ id: o.id, sim: o.embedding ? cosine(queryVec, o.embedding) : 0 }))
      .sort((a, b) => b.sim - a.sim)
      .slice(0, 8)
      .map((x) => x.id);
    const top8Survive = top8ByCosine.filter((x) => branchSet.has(x)).length;

    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(
      `${id.padEnd(16)} main=${mainIds.length} branch=${branchIds.length} overlap=${intersection.length} jaccard=${jaccard.toFixed(2)} top8-survive=${top8Survive}/8 (${secs}s)`,
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
