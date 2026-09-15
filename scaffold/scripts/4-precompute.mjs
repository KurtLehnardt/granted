/**
 * Step 4 — demo-day insurance.
 * Runs all five judged test cases against your LOCAL dev server and freezes
 * the results. The app serves these instantly, so venue wifi and API latency
 * can't break the exact five things the judges will type.
 *
 * Run this AFTER the app works, and re-run whenever matching logic changes.
 * Requires `npm run dev` in another terminal.
 */
import "./_loadEnvLocal.mjs"; // honor scaffold/.env.local when run as plain `node`
import { writeFile } from "node:fs/promises";

const CASES = [
  ["ai-healthcare", "We're a 15-person Utah company developing AI-powered software that helps hospitals reduce administrative work for nurses. We've raised $2.5M, have $1M in ARR, and are looking for $500K–$2M of non-dilutive capital to fund product development and hospital pilots."],
  ["manufacturing", "We're a 35-person Utah hardware startup doing advanced manufacturing for lightweight aerospace components. $3M in revenue, raised $8M, looking for $2M–$5M for manufacturing scale-up and R&D."],
  ["water", "We're a 10-person Utah startup with a sensor and AI platform that reduces municipal water loss. $500K revenue, raised $1.5M, seeking $500K–$3M for product development and municipal pilots."],
  ["cyber", "We're a 22-person Utah cybersecurity startup building AI-powered threat detection for small and mid-sized organizations. $2M ARR, raised $5M, seeking $1M–$3M for R&D and federal/commercial expansion."],
  ["marketplace", "We're an 8-person Utah technology startup running a marketplace connecting parents with local youth activities and enrichment programs. $750K revenue, raised $1M, looking for $250K–$1M for expansion and technology development."],
];

// Grafana holds :3000 on the build machine, so `next dev` binds :3001. Override
// with PORT if your dev server is elsewhere: PORT=3000 node scripts/4-precompute.mjs
const PORT = process.env.PORT || "3001";

/**
 * H9 — /api/match streams newline-delimited JSON
 * ({type:"progress"|"result"|"error"}), NOT a single JSON body. The old
 * `res.json()` parsed the whole NDJSON blob as one object and ALWAYS threw, so
 * this script could never regenerate the demo cases. Read the stream and keep
 * the terminal `result` line's map (and surface a streamed `error`).
 */
async function readResultFromNdjson(res) {
  const body = await res.text(); // buffers the whole stream — fine for a script
  let map = null;
  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let msg;
    try { msg = JSON.parse(trimmed); } catch { continue; }
    if (msg.type === "result") map = msg.map;
    else if (msg.type === "error") throw new Error(msg.error ?? "match failed");
  }
  return map;
}

const out = [];
for (const [id, text] of CASES) {
  process.stdout.write(`${id.padEnd(16)} `);
  try {
    const res = await fetch(`http://localhost:${PORT}/api/match`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ description: text }),
    });
    if (!res.ok) {
      let detail = "";
      try { detail = (await res.json())?.error ?? ""; } catch { /* non-JSON body */ }
      console.log(`FAILED ${res.status} ${detail}`.trim());
      continue;
    }
    const map = await readResultFromNdjson(res);
    if (!map) { console.log("FAILED (stream ended without a result)"); continue; }

    out.push({ key: text.trim().slice(0, 120), id, map });
    const strong = map.summary.highPotential;
    const weak = map.weakFieldFinding ? " + weak-field finding" : "";
    // ELG-04 visibility: confirm the regenerated matches carry `eligibility`.
    const withElig = (map.matches ?? []).filter((m) => m.eligibility).length;
    console.log(`${strong} strong matches${weak} · ${withElig}/${(map.matches ?? []).length} with eligibility`);
  } catch (err) {
    console.log(`FAILED ${err.message}`);
  }
}

await writeFile("data/precomputed.json", JSON.stringify(out, null, 2));
console.log(`\n→ ${out.length}/5 cases frozen into data/precomputed.json`);
console.log("Check case 5 returned a weak-field finding. If it didn't, raise CALIBRATION.scoreFloor in lib/match.ts.");
