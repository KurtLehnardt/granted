// ============================================================================
// EVAL + COST harness (quality/honest-no + R4b cost-per-search).
// ----------------------------------------------------------------------------
// Calls `buildOpportunityMap` DIRECTLY (no dev server) against a set of
// DIVERSE, ADVERSARIAL company profiles designed to probe the honest-no /
// calibration behavior (the product differentiator: an honest "probably not a
// fit" instead of a fabricated match). For each profile it captures BOTH:
//
//   (A) the full quality picture — per-match {kind, score, tier, discernment
//       recommendation, criteria met/total, eligibility bucket}, the summary
//       counts, the whole-map verdict, and whether a weak-field finding fired;
//   (B) the R4b cost/latency breakdown that lib/metering/meter.ts produces.
//
// Flags set BEFORE importing lib/match.ts (a dynamic import is what guarantees
// the env is set first in ESM):
//   - NEXT_PUBLIC_FLAG_R4B_COST_DEBUG=true  → map.costDebug is populated.
//   - NEXT_PUBLIC_FLAG_DISCERNMENT_LAYER=true → per-match recommendation +
//     whole-map verdict computed. Discernment is a PURE post-processing pass
//     over the already-computed score/criteria, so the LLM scoring (the only
//     thing that costs money) is identical with it on or off — we capture the
//     discernment-ON view AND still recompute the discernment-OFF honest-no
//     (strong = score>=33, weak if <1) offline from the same per-match scores.
//
// SPENDS REAL API CREDITS — one live Anthropic+OpenAI search per profile.
// Requires ANTHROPIC_API_KEY + OPENAI_API_KEY (interactive shell: source
// ~/.zshrc first). A per-case try/catch records any error and moves on, so a
// 429/quota exhaustion mid-run degrades to partial results rather than a crash.
//
// Run all profiles:      node --import tsx scripts/eval-run.mjs
// Run a subset by id:    node --import tsx scripts/eval-run.mjs strong-rd vague
//
// Writes raw results (full slim map + costDebug per case) to the path in
// EVAL_OUT (default ./eval-results.json) for the report generator.
// ============================================================================

import { writeFile, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

// The app keys (ANTHROPIC_API_KEY / OPENAI_API_KEY / EXA_API_KEY) live in
// ~/.zshrc and only load in interactive shells. This best-effort loader reads
// the `export KEY=...` lines directly (NEVER printing any value) and seeds
// process.env, so this harness runs under a plain `node` invocation without a
// `source ~/.zshrc` shell step. It PREFERS the ~/.zshrc value over anything
// already in the environment: the Claude Code harness injects its own
// ANTHROPIC_API_KEY (scoped to the CLI, invalid for the direct Anthropic SDK),
// which would otherwise shadow the real app key and 401.
async function loadKeysFromZshrc() {
  const wanted = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "EXA_API_KEY"];
  let text = "";
  try {
    text = await readFile(join(homedir(), ".zshrc"), "utf8");
  } catch {
    return; // no ~/.zshrc — rely on whatever's already in the env
  }
  for (const key of wanted) {
    const m = text.match(new RegExp(`^\\s*export\\s+${key}\\s*=\\s*(.+?)\\s*$`, "m"));
    if (!m) continue;
    let val = m[1].trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (val) process.env[key] = val;
  }
}
await loadKeysFromZshrc();

process.env.NEXT_PUBLIC_FLAG_R4B_COST_DEBUG = "true";
process.env.NEXT_PUBLIC_FLAG_DISCERNMENT_LAYER = "true";

const { buildOpportunityMap } = await import("../lib/match.ts");

// 8 adversarial profiles spanning the calibration matrix. NONE overlaps the 5
// judged demo cases (those are precomputed/cached and free) — these are novel,
// real-money inputs chosen to stress the honest-no from both directions.
const PROFILES = [
  {
    id: "strong-rd",
    band: "STRONG R&D (positive control)",
    expect: "Strong SBIR/rd/DoD matches; NO honest-no. If weak-field fires here, calibration is too tight.",
    text:
      "We're a 20-person Utah company developing autonomous drone navigation systems using novel AI " +
      "and advanced sensor fusion for defense and search-and-rescue applications. We're a US-owned " +
      "small business, $1.5M in revenue, raised $4M, actively running an R&D program, and seeking " +
      "$1M-$3M in non-dilutive funding for prototype development and government pilots.",
  },
  {
    id: "borderline",
    band: "BORDERLINE (thin-R&D B2B SaaS)",
    expect: "Mostly adjacent/verify; thin_map. Watch for over-generous grant/rd recommends.",
    text:
      "We're a 12-person Utah B2B SaaS company selling subscription accounting and invoicing software " +
      "to small businesses. $2M ARR, raised $3M. We do some product development but no formal research. " +
      "Looking for $500K-$1M to expand our sales and engineering team.",
  },
  {
    id: "consumer-app",
    band: "CLEAR NO (consumer social app)",
    expect: "Honest-no / no_fit. FABRICATION CHECK: no federal grant should read as 'recommend'.",
    text:
      "We're a 6-person startup building a mobile app for sharing short-form cooking videos with friends. " +
      "Based in California, pre-revenue, raised $500K from angels. We want $1M to grow our user base and " +
      "add social features.",
  },
  {
    id: "local-service",
    band: "CLEAR NO (local service, non-R&D)",
    expect: "Honest-no; SBA/loan redirect acceptable. Watch over-generosity on grants.",
    text:
      "We run a 40-person commercial landscaping and lawn-care business serving residential and commercial " +
      "clients across the Salt Lake City metro area. $4M in annual revenue, profitable, no outside " +
      "investment. We're looking for about $750K to buy new equipment and open a second location.",
  },
  {
    id: "dating-app",
    band: "CLEAR NO (dating app)",
    expect: "Honest-no / no_fit.",
    text:
      "We're a 5-person startup in New York building a dating app that uses AI to match people based on " +
      "personality quizzes. Pre-revenue, raised $2M seed. We need $3M to scale marketing and grow our " +
      "user base in major cities.",
  },
  {
    id: "oversized",
    band: "INELIGIBLE BY SIZE (8,000-employee multinational)",
    expect:
      "SBIR small-business ineligibility should surface (whyIneligible mentions size). Watch whether " +
      "rd/SBIR over-recommends despite obvious size ineligibility.",
    text:
      "We're a large multinational corporation with 8,000 employees and $2.5 billion in annual revenue, " +
      "headquartered in Utah, developing enterprise cloud infrastructure and AI data-center hardware. " +
      "We run an extensive R&D division and are seeking $5M-$20M in federal R&D funding.",
  },
  {
    id: "vague",
    band: "VAGUE ONE-LINER (near-zero info)",
    expect: "Follow-ups, honest-no, or thin. FABRICATION CHECK: must not confidently fabricate strong matches.",
    text: "We build software and want government funding.",
  },
  {
    id: "foreign-owned",
    band: "FOREIGN-OWNED, NON-R&D",
    expect:
      "Strong honest-no. whyIneligible should cite foreign ownership / US-based requirement / no R&D.",
    text:
      "We're a UK-based, British-owned retail company with 200 employees selling home goods and furniture " +
      "online to European customers. £30M revenue. We have no US operations and do no research. We'd like " +
      "$2M in US government grants to expand into the American market.",
  },
];

// The discernment-OFF honest-no rule, recomputed offline from per-match scores
// so BOTH honest-no mechanisms are reported from the SAME (single, paid) run.
const SCORE_FLOOR = 33; // CALIBRATION.scoreFloor
const WEAK_FIELD_THRESHOLD = 1; // CALIBRATION.weakFieldThreshold

function slimMatch(m) {
  const total = (m.criteria ?? []).length;
  const met = (m.criteria ?? []).filter((c) => c.met).length;
  return {
    id: m.opportunity?.id,
    program: m.opportunity?.title || m.opportunity?.program || m.opportunity?.id,
    agency: m.opportunity?.agency,
    kind: m.opportunity?.kind,
    score: m.score,
    tier: m.tier,
    rec: m.recommendation?.recommendation ?? null,
    recLabel: m.recommendation?.label ?? null,
    criteriaMet: `${met}/${total}`,
    eligBucket: m.eligibility?.bucket ?? null,
    whyIneligible: (m.whyIneligible ?? "").slice(0, 240),
  };
}

function analyze(map) {
  const matches = map.matches ?? [];
  const strongOff = matches.filter((m) => m.score >= SCORE_FLOOR);
  const recommend = matches.filter((m) => m.recommendation?.recommendation === "recommend");
  const verify = matches.filter((m) => m.recommendation?.recommendation === "verify");
  const doNot = matches.filter((m) => m.recommendation?.recommendation === "do_not_recommend");
  const maxScore = matches.reduce((mx, m) => Math.max(mx, m.score), 0);
  return {
    honestNo_discernmentOff: strongOff.length < WEAK_FIELD_THRESHOLD, // weak-field fires
    honestNo_discernmentOn: map.mapVerdict === "no_fit" || map.mapVerdict === "thin_map",
    mapVerdict: map.mapVerdict ?? null,
    weakFieldFired: !!map.weakFieldFinding,
    counts: {
      totalMatches: matches.length,
      strong_scoreGte33: strongOff.length,
      recommend: recommend.length,
      verify: verify.length,
      do_not_recommend: doNot.length,
      maxScore,
    },
    summary: map.summary ?? null,
    // The over-generosity red flag: any RECOMMENDED match on a clear-no profile.
    recommendedMatches: recommend.map(slimMatch),
    topMatches: [...matches].sort((a, b) => b.score - a.score).slice(0, 8).map(slimMatch),
  };
}

function parseArgs(argv) {
  if (argv.length === 0) return PROFILES;
  const wanted = new Set(argv);
  return PROFILES.filter((p) => wanted.has(p.id));
}

function fmtUsd(n) {
  return `$${Number(n ?? 0).toFixed(4)}`;
}

async function main() {
  const cases = parseArgs(process.argv.slice(2));
  const results = [];

  for (const p of cases) {
    console.log(`\n=== ${p.id}  [${p.band}] ===`);
    const t0 = Date.now();
    try {
      const map = await buildOpportunityMap(p.text);
      const elapsedMs = Date.now() - t0;
      const a = analyze(map);
      const cost = map.costDebug;
      results.push({
        id: p.id,
        band: p.band,
        expect: p.expect,
        text: p.text,
        elapsedMs,
        analysis: a,
        costDebug: cost,
      });
      console.log(
        `  verdict=${a.mapVerdict}  weakField=${a.weakFieldFired}  ` +
          `matches=${a.counts.totalMatches} recommend=${a.counts.recommend} verify=${a.counts.verify} ` +
          `do_not=${a.counts.do_not_recommend} maxScore=${a.counts.maxScore}`,
      );
      console.log(
        `  honest-no: discernmentOFF=${a.honestNo_discernmentOff}  discernmentON=${a.honestNo_discernmentOn}`,
      );
      if (a.recommendedMatches.length) {
        console.log(`  RECOMMENDED (${a.recommendedMatches.length}):`);
        for (const m of a.recommendedMatches) {
          console.log(`    - [${m.kind} ${m.score} elig=${m.eligBucket}] ${m.program} (${m.agency})`);
        }
      }
      if (cost) {
        console.log(`  cost=${fmtUsd(cost.totalCostUsd)}  latency=${Math.round(cost.totalLatencyMs)}ms  wall=${elapsedMs}ms`);
        for (const s of cost.stages) {
          console.log(
            `    ${String(s.stage).padEnd(22)} calls=${s.calls} in=${s.inputTokens} out=${s.outputTokens} ${fmtUsd(s.costUsd)} ${Math.round(s.latencyMs)}ms`,
          );
        }
      } else {
        console.log("  (no costDebug — is NEXT_PUBLIC_FLAG_R4B_COST_DEBUG=true?)");
      }
    } catch (err) {
      const elapsedMs = Date.now() - t0;
      const msg = err?.message ?? String(err);
      console.error(`  FAILED after ${elapsedMs}ms: ${msg}`);
      results.push({ id: p.id, band: p.band, error: msg, elapsedMs });
      // Hard stop on quota exhaustion — never keep hammering a dead account.
      if (/429|insufficient_quota|rate.?limit|credit|overloaded|quota/i.test(msg)) {
        console.error("  QUOTA/RATE signal detected — stopping remaining live runs.");
        break;
      }
    }
  }

  const outPath = process.env.EVAL_OUT || "./eval-results.json";
  await writeFile(outPath, JSON.stringify(results, null, 2));
  const ok = results.filter((r) => !r.error).length;
  console.log(`\n→ wrote ${results.length} result(s) (${ok} succeeded) to ${outPath}`);

  // Cost/latency aggregate across successful runs.
  const costs = results.filter((r) => r.costDebug).map((r) => r.costDebug.totalCostUsd);
  const lats = results.filter((r) => r.costDebug).map((r) => r.costDebug.totalLatencyMs);
  if (costs.length) {
    const agg = (arr) => {
      const s = [...arr].sort((a, b) => a - b);
      const mean = s.reduce((a, b) => a + b, 0) / s.length;
      const median = s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
      const p90 = s[Math.min(s.length - 1, Math.ceil(0.9 * s.length) - 1)];
      return { mean, median, p90, min: s[0], max: s[s.length - 1] };
    };
    const c = agg(costs);
    const l = agg(lats);
    console.log(`\nCOST across ${costs.length} runs: mean=${fmtUsd(c.mean)} median=${fmtUsd(c.median)} p90=${fmtUsd(c.p90)} min=${fmtUsd(c.min)} max=${fmtUsd(c.max)}`);
    console.log(
      `LATENCY(ms): mean=${Math.round(l.mean)} median=${Math.round(l.median)} p90=${Math.round(l.p90)} min=${Math.round(l.min)} max=${Math.round(l.max)}`,
    );
  }
}

main().catch((err) => {
  console.error("eval-run failed:", err?.message ?? err);
  process.exit(1);
});
