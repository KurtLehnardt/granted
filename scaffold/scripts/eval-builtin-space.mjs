/**
 * Free quality checks for the built-in search space (no API calls, no keys):
 *
 *   npm run eval:builtin      (from scaffold/; needs `npm run model:fetch`)
 *
 *   A. Neighbour overlap: for sampled programs, how many of each one's 24
 *      nearest neighbours under the shipped OpenAI vectors are also among its 24
 *      nearest under the built-in vectors.
 *   B. Floor calibration: programs used as queries (OpenAI: the document vector
 *      itself; built-in: the program text embedded as a search query). For
 *      OpenAI, the share of the corpus clearing its 0.22 floor; the built-in
 *      floor that admits the same share.
 *   C. The 4 demo searches (data/precomputed.json, scored by the OpenAI + Claude
 *      pipeline): where their strong matches (score >= 33) rank in the built-in
 *      space, and whether they clear its floor. Plus the same with BM25 alone.
 *   D. The golden set's 34 descriptions as queries: candidates clearing the floor.
 */
import { readFileSync } from "node:fs";
import { loadBuiltinEmbedder, builtinModelPresent } from "./lib/builtinModel.mjs";
import { readVectorFile } from "./lib/vectorFile.mjs";
import { spaceDocumentText } from "./lib/spaceVectors.mjs";
import { SPACES } from "./lib/spaces.mjs";

if (!builtinModelPresent()) {
  console.error("Run `npm run model:fetch` first.");
  process.exit(1);
}

const space = SPACES.builtin;
const opps = JSON.parse(readFileSync("data/opportunities.json", "utf8"));
const N = opps.length;
const file = readVectorFile("data/vectors", space.vectors.name);
const unit = (v) => {
  let s = 0;
  for (const x of v) s += x * x;
  s = Math.sqrt(s) || 1;
  return v.map((x) => x / s);
};
const oai = opps.map((o) => Float32Array.from(unit(o.embedding)));
const nom = opps.map((o) => Float32Array.from(file.vectors.get(o.id).vector));
const dot = (a, b) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
};
const sims = (q, vecs) => vecs.map((v) => dot(q, v));
const topk = (s, k, skip = -1) =>
  s
    .map((x, i) => [i, i === skip ? -9 : x])
    .sort((a, b) => b[1] - a[1])
    .slice(0, k)
    .map((x) => x[0]);
let seed = 7;
const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const pct = (x) => `${(x * 100).toFixed(1)}%`;
const quantile = (arr, q) => arr.slice().sort((a, b) => a - b)[Math.min(arr.length - 1, Math.floor(q * arr.length))];

const embedder = await loadBuiltinEmbedder();
const embedQueries = async (texts) => {
  const out = [];
  for (let i = 0; i < texts.length; i += 16) out.push(...(await embedder.embed(texts.slice(i, i + 16).map((t) => space.queryPrefix + t))));
  return out.map((v) => Float32Array.from(v));
};

// A. neighbour overlap
const sample = Array.from({ length: 400 }, () => Math.floor(rnd() * N));
let overlap = 0;
for (const i of sample) {
  const a = new Set(topk(sims(oai[i], oai), 24, i));
  for (const j of topk(sims(nom[i], nom), 24, i)) if (a.has(j)) overlap++;
}
console.log(`A. Neighbour overlap@24, OpenAI vs built-in, 400 sampled programs: ${pct(overlap / (24 * sample.length))}`);

// B. floor calibration from the corpus's own similarity distribution
const qSample = Array.from({ length: 200 }, () => Math.floor(rnd() * N));
const OPENAI_FLOOR = SPACES.openai.candidateFloor;
const oaiShares = qSample.map((i) => sims(oai[i], oai).filter((s, j) => j !== i && s >= OPENAI_FLOOR).length / (N - 1));
const share = oaiShares.reduce((a, b) => a + b, 0) / oaiShares.length;
const qVecs = await embedQueries(qSample.map((i) => `${opps[i].program}. ${opps[i].agency}. ${opps[i].description}`.slice(0, 2000)));
const pooled = [];
qVecs.forEach((q, k) => sims(q, nom).forEach((s, j) => j !== qSample[k] && pooled.push(s)));
const matchedFloor = quantile(pooled, 1 - share);
const builtinShare = pooled.filter((s) => s >= space.candidateFloor).length / pooled.length;
console.log(
  `B. OpenAI: ${pct(share)} of the corpus clears its ${OPENAI_FLOOR} floor for a program-as-query (median ${pct(quantile(oaiShares, 0.5))}).\n` +
    `   Built-in query-to-program cosine p10/p50/p90/p99: ${[0.1, 0.5, 0.9, 0.99].map((q) => quantile(pooled, q).toFixed(3)).join(" / ")}\n` +
    `   Built-in floor admitting the same share: ${matchedFloor.toFixed(3)}; shipped floor ${space.candidateFloor} admits ${pct(builtinShare)}.`,
);

// C. the 4 demo searches
const { buildBM25Index, bm25Query } = await import("../lib/retrieval/bm25.ts").catch(() => ({}));
const pre = JSON.parse(readFileSync("data/precomputed.json", "utf8"));
const idx = new Map(opps.map((o, i) => [o.id, i]));
const qText = (p) => [p.description, p.technology, p.industry, p.rdActivities, p.targetCustomers, (p.expandedTerms ?? []).join(", ")].filter(Boolean).join("\n");
const bm = buildBM25Index ? buildBM25Index(opps) : null;
let strongTotal = 0, at24 = 0, at50 = 0, clear = 0, bm24 = 0;
const lines = [];
for (const e of pre) {
  const strong = e.map.matches.filter((m) => m.score >= 33 && idx.has(m.opportunity.id)).map((m) => idx.get(m.opportunity.id));
  const [q] = await embedQueries([qText(e.map.profile)]);
  const s = sims(q, nom);
  const order = topk(s, N);
  const rank = new Map(order.map((i, r) => [i, r + 1]));
  const bmTop = bm ? new Set(bm25Query(bm, qText(e.map.profile)).slice(0, 24).map((h) => idx.get(h.id))) : new Set();
  strongTotal += strong.length;
  for (const i of strong) {
    if (rank.get(i) <= 24) at24++;
    if (rank.get(i) <= 50) at50++;
    if (s[i] >= space.candidateFloor) clear++;
    if (bmTop.has(i)) bm24++;
  }
  lines.push(`   ${e.id}: strong-match ranks ${strong.map((i) => `${rank.get(i)} (cos ${s[i].toFixed(2)})`).join(", ")}`);
}
console.log(
  `C. Demo searches: ${strongTotal} strong matches; built-in has ${at24} in its top 24, ${at50} in its top 50, ${clear} clear its floor; BM25 alone has ${bm24} in its top 24.\n` +
    lines.join("\n"),
);

// C2. the same demo searches through the real retrieval (lib/match.ts: global top 24, per-type
// quotas, BM25 supplement, raw-description pass), with the scorer stubbed out to record what
// it would have been sent.
process.env.SEARCH_EMBEDDINGS = "builtin";
const { buildOpportunityMap } = await import("../lib/match.ts");
let sent = 0;
const sentLines = [];
for (const e of pre) {
  const strong = e.map.matches.filter((m) => m.score >= 33 && idx.has(m.opportunity.id)).map((m) => m.opportunity.id);
  let ids = new Set();
  await buildOpportunityMap(e.map.profile.description, undefined, {
    extractProfile: async () => ({ profile: e.map.profile, followUps: [] }),
    explainMatches: async (_p, candidates) => {
      ids = new Set(candidates.map((c) => c.id));
      return candidates.map((c) => ({ id: c.id, score: 0, tier: "none", criteria: [] }));
    },
    explainMatchesTwoPass: async (_p, candidates) => {
      ids = new Set(candidates.map((c) => c.id));
      return candidates.map((c) => ({ id: c.id, score: 0, tier: "none", criteria: [] }));
    },
    explainWeakField: async () => ({ headline: "", reasoning: "", redirects: [] }),
  }).catch((err) => console.error(`   (${e.id}: ${err.message})`));
  const hit = strong.filter((id) => ids.has(id));
  sent += hit.length;
  sentLines.push(`   ${e.id}: ${hit.length} of ${strong.length} strong matches among the ${ids.size} candidates sent to scoring`);
}
console.log(`C2. Through the real retrieval: ${sent} of ${strongTotal} strong matches reach scoring.\n${sentLines.join("\n")}`);

// D. golden set
const gold = readFileSync("../evals/golden-set.jsonl", "utf8").trim().split("\n").map((l) => JSON.parse(l));
const gVecs = await embedQueries(gold.map((g) => g.description));
const counts = gVecs.map((q) => sims(q, nom).filter((s) => s >= space.candidateFloor).length);
console.log(
  `D. Golden set (${gold.length} descriptions): programs clearing the built-in floor per query, min/median/max ${Math.min(...counts)} / ${quantile(counts, 0.5)} / ${Math.max(...counts)}; ` +
    `${counts.filter((c) => c < 24).length} queries have fewer than 24.`,
);
