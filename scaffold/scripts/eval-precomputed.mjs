// ============================================================================
// Offline (FREE) quality analysis of the 5 judged/standard test cases.
// ----------------------------------------------------------------------------
// Reads data/precomputed.json (the frozen demo-day maps for the 5 cases — no
// API calls, no cost) and reports the honest-no / calibration picture for each:
//   - discernment-OFF (shipped default): weak-field fires when 0 matches clear
//     scoreFloor(33).
//   - discernment-ON (candidate layer): applies the REAL recommendFor() +
//     mapVerdict() from lib/recommend.ts over the same frozen per-match scores.
// This lets us validate the honest-no on the known cases without spending a
// single live search, and cross-check against the novel adversarial set.
// ============================================================================

import { readFile } from "node:fs/promises";
import { recommendFor, mapVerdict } from "../lib/recommend.ts";

const SCORE_FLOOR = 33;
const WEAK_FIELD_THRESHOLD = 1;

const raw = JSON.parse(await readFile(new URL("../data/precomputed.json", import.meta.url), "utf8"));

function met(m) {
  const total = (m.criteria ?? []).length;
  const n = (m.criteria ?? []).filter((c) => c.met).length;
  return { met: n, total };
}

function analyze(map) {
  const matches = map.matches ?? [];
  const withRec = matches.map((m) => ({
    m,
    rec: recommendFor({ adjustedScore: m.score, kind: m.opportunity?.kind, criteria: m.criteria ?? [], statedDisqualifier: false }),
  }));
  const recommend = withRec.filter((x) => x.rec.recommendation === "recommend");
  const verify = withRec.filter((x) => x.rec.recommendation === "verify");
  const doNot = withRec.filter((x) => x.rec.recommendation === "do_not_recommend");
  const maxScore = matches.reduce((mx, m) => Math.max(mx, m.score), 0);
  const strongOff = matches.filter((m) => m.score >= SCORE_FLOOR);
  const verdict = mapVerdict({ recommendCount: recommend.length, verifyCount: verify.length, maxScore });
  return { matches, withRec, recommend, verify, doNot, maxScore, strongOff, verdict };
}

for (const entry of raw) {
  const id = entry.id;
  const map = entry.map;
  const a = analyze(map);
  console.log(`\n=== ${id} ===`);
  console.log(
    `  shipped(disc OFF): highPotential(summary)=${map.summary?.highPotential} ` +
      `strong(score>=33)=${a.strongOff.length} weakFieldFired=${!!map.weakFieldFinding} ` +
      `honestNo=${a.strongOff.length < WEAK_FIELD_THRESHOLD}`,
  );
  console.log(
    `  discernment ON: verdict=${a.verdict} recommend=${a.recommend.length} verify=${a.verify.length} ` +
      `do_not=${a.doNot.length} maxScore=${a.maxScore} honestNo=${a.verdict === "no_fit" || a.verdict === "thin_map"}`,
  );
  // Tier distribution (shipped).
  const tierCounts = {};
  for (const m of a.matches) tierCounts[m.tier] = (tierCounts[m.tier] ?? 0) + 1;
  console.log(`  tiers: ${JSON.stringify(tierCounts)}  totalMatches=${a.matches.length}`);
  // Recommended set under discernment (over-generosity check on case 5).
  if (a.recommend.length) {
    console.log(`  RECOMMENDED under discernment (${a.recommend.length}):`);
    for (const x of a.recommend) {
      const c = met(x.m);
      console.log(`    - [${x.m.opportunity?.kind} score=${x.m.score} ${c.met}/${c.total}] ${x.m.opportunity?.title || x.m.opportunity?.program} (${x.m.opportunity?.agency})`);
    }
  }
  // Top 5 by score for visibility.
  const top = [...a.matches].sort((x, y) => y.score - x.score).slice(0, 5);
  console.log(`  top5: ` + top.map((m) => `${m.opportunity?.kind}:${m.score}:${m.tier}`).join("  "));
}
