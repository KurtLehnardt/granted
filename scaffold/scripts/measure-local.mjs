/**
 * NDJSON-aware local calibration probe. Hits the running dev server (:3001 by
 * default), parses the streamed NDJSON, and prints the matching verdict per case.
 * Usage: node scripts/measure-local.mjs [caseIndices]   e.g. `node scripts/measure-local.mjs 1 5`
 * (1-based indices into the 5 standard cases; default = all five).
 */
const PORT = process.env.PORT || "3001";
const CASES = [
  ["1 ai-healthcare", "We're a 15-person Utah company developing AI-powered software that helps hospitals reduce administrative work for nurses. We've raised $2.5M, have $1M in ARR, and are looking for $500K–$2M of non-dilutive capital to fund product development and hospital pilots."],
  ["2 manufacturing", "We're a 35-person Utah hardware startup doing advanced manufacturing for lightweight aerospace components. $3M in revenue, raised $8M, looking for $2M–$5M for manufacturing scale-up and R&D."],
  ["3 water", "We're a 10-person Utah startup with a sensor and AI platform that reduces municipal water loss. $500K revenue, raised $1.5M, seeking $500K–$3M for product development and municipal pilots."],
  ["4 cyber", "We're a 22-person Utah cybersecurity startup building AI-powered threat detection for small and mid-sized organizations. $2M ARR, raised $5M, seeking $1M–$3M for R&D and federal/commercial expansion."],
  ["5 marketplace", "We're an 8-person Utah technology startup running a marketplace connecting parents with local youth activities and enrichment programs. $750K revenue, raised $1M, looking for $250K–$1M for expansion and technology development."],
];
const pick = process.argv.slice(2).map(Number).filter(Boolean);
const chosen = pick.length ? pick.map((i) => CASES[i - 1]).filter(Boolean) : CASES;

for (const [id, text] of chosen) {
  const t0 = Date.now();
  try {
    const res = await fetch(`http://localhost:${PORT}/api/match`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ description: text }),
    });
    const raw = await res.text();
    let map = null;
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try { const o = JSON.parse(line); if (o.type === "result") map = o.map; else if (o.map) map = o.map; else if (o.summary) map = o; } catch {}
    }
    if (!map) { try { const o = JSON.parse(raw); map = o.map || o; } catch {} }
    const secs = ((Date.now() - t0) / 1000).toFixed(0);
    if (!map) { console.log(`${id.padEnd(16)} NO-MAP http=${res.status} ${raw.slice(0, 160)}`); continue; }
    const matches = map.matches || [];
    const tiers = {}; matches.forEach((x) => { tiers[x.tier] = (tiers[x.tier] || 0) + 1; });
    const recs = {}; matches.forEach((x) => { const r = x.recommendation || x.recommend || "?"; recs[r] = (recs[r] || 0) + 1; });
    const verdict = map.verdict || map.mapVerdict || map.summary?.verdict || "(none)";
    console.log(`${id.padEnd(16)} highPotential=${map.summary?.highPotential} weakField=${map.weakFieldFinding ? "YES" : "no"} verdict=${JSON.stringify(verdict)} tiers=${JSON.stringify(tiers)} recs=${JSON.stringify(recs)} (${secs}s)`);
    matches.slice(0, 8).forEach((x) => console.log(`    score=${x.score} tier=${x.tier} rec=${x.recommendation || x.recommend || "-"} ${(x.opportunity?.agency || "").slice(0, 22)} | ${(x.opportunity?.program || "").slice(0, 40)}`));
  } catch (e) { console.log(`${id.padEnd(16)} ERROR ${e.message}`); }
}
console.log("DONE");
