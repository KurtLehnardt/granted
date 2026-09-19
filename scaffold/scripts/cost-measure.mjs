// ============================================================================
// R4b — real cost-per-search measurement harness.
// ----------------------------------------------------------------------------
// Calls `buildOpportunityMap` DIRECTLY (no dev server, unlike
// scripts/4-precompute.mjs / scripts/dev-calibrate.mjs — this never fetches
// localhost), against a small set of company descriptions, and prints +
// writes the real per-stage token/cost/latency breakdown that
// lib/metering/meter.ts produces.
//
// Sets NEXT_PUBLIC_FLAG_R4B_COST_DEBUG=true before importing lib/match.ts so
// buildOpportunityMap()'s returned OpportunityMap carries `costDebug`
// (lib/flags — gated OFF by default; see lib/flags/registry.ts's
// r4b_cost_debug entry: "cost figures must never reach the end-user UI
// without this flag").
//
// SPENDS REAL API CREDITS. This is not a dry run — it calls the live
// Anthropic and OpenAI APIs via lib/claude.ts / lib/embed.ts. Requires
// ANTHROPIC_API_KEY and OPENAI_API_KEY in the environment; without them,
// buildOpportunityMap() throws immediately inside extractProfile()'s
// client() call — that's expected (this script's argument-parsing and
// JSON-writing logic still runs and can be sanity-checked without keys; the
// per-case try/catch below records the error and moves on).
//
// The five cases below are intentionally DIFFERENT from the five judged
// cases in scripts/dev-calibrate.mjs and scripts/4-precompute.mjs
// (ai-healthcare / manufacturing / water / cyber / marketplace) — this is
// R4b's own measurement set, not the frozen demo-day cache, so a reviewer
// can't mistake this script's output for that precomputed set.
//
// Run:
//   npm run cost:measure
//   npm run cost:measure -- "custom company description" "another one"
//
// Writes raw { id, description, summary, costDebug, elapsedMs } results to
// /tmp/r4b-cost-results.json for turning into a findings writeup separately
// (out of scope for this script/task; see the R4b task spec's "Out of scope"
// section).
// ============================================================================

import { writeFile } from "node:fs/promises";

// MUST be set before importing lib/match.ts (which transitively imports
// lib/flags) so a debug/admin view of this run's cost breakdown populates on
// every returned OpportunityMap — a dynamic import (not a static one) is what
// lets us guarantee this env var is set first in an ESM module.
process.env.NEXT_PUBLIC_FLAG_R4B_COST_DEBUG = "true";

const { buildOpportunityMap } = await import("../lib/match.ts");

const DEFAULT_CASES = [
  [
    "agtech",
    "We're a 12-person Colorado agtech startup building soil-sensor hardware and a prediction model that tells row-crop farmers when to irrigate. $400K revenue, raised $1.2M seed, seeking $500K-$1.5M for field trials and USDA pilot programs.",
  ],
  [
    "biotech",
    "We're a 6-person Massachusetts biotech spinout developing a low-cost diagnostic assay for early sepsis detection in rural hospitals. Pre-revenue, raised $900K in a pre-seed round, looking for $1M-$4M in non-dilutive funding for clinical validation.",
  ],
  [
    "energy",
    "We're a 28-person Texas cleantech company building grid-scale battery recycling technology to recover lithium and cobalt from retired EV batteries. $4M revenue, raised $12M Series A, seeking $3M-$8M for a pilot recycling facility.",
  ],
];

function parseArgs(argv) {
  if (argv.length === 0) return DEFAULT_CASES;
  return argv.map((text, i) => [`arg-${i + 1}`, text]);
}

function pad(value, width) {
  return String(value).padEnd(width).slice(0, width);
}
function padNum(value, width) {
  return String(value).padStart(width);
}

function printStageTable(id, costDebug, elapsedMs) {
  if (!costDebug) {
    console.log(`  (no costDebug on the response for "${id}" — is NEXT_PUBLIC_FLAG_R4B_COST_DEBUG really "true"?)`);
    return;
  }
  console.log(`  ${pad("stage", 24)} ${padNum("calls", 5)} ${padNum("in_tok", 8)} ${padNum("out_tok", 8)} ${padNum("cost($)", 9)} ${padNum("latency(ms)", 12)}`);
  for (const s of costDebug.stages) {
    console.log(
      `  ${pad(s.stage, 24)} ${padNum(s.calls, 5)} ${padNum(s.inputTokens, 8)} ${padNum(s.outputTokens, 8)} ${padNum(s.costUsd.toFixed(4), 9)} ${padNum(Math.round(s.latencyMs), 12)}`,
    );
  }
  console.log(
    `  ${pad("TOTAL", 24)} ${padNum("", 5)} ${padNum("", 8)} ${padNum("", 8)} ${padNum(costDebug.totalCostUsd.toFixed(4), 9)} ${padNum(Math.round(costDebug.totalLatencyMs), 12)}`,
  );
  console.log(`  wall-clock (script-measured): ${elapsedMs}ms   pricingAsOf: ${costDebug.pricingAsOf}`);
}

async function main() {
  const cases = parseArgs(process.argv.slice(2));
  const results = [];

  for (const [id, description] of cases) {
    console.log(`\n=== ${id} ===`);
    const t0 = Date.now();
    try {
      const map = await buildOpportunityMap(description);
      const elapsedMs = Date.now() - t0;
      results.push({ id, description, summary: map.summary, costDebug: map.costDebug, elapsedMs });
      printStageTable(id, map.costDebug, elapsedMs);
    } catch (err) {
      const elapsedMs = Date.now() - t0;
      console.error(`  FAILED after ${elapsedMs}ms: ${err?.message ?? err}`);
      results.push({ id, description, error: err?.message ?? String(err), elapsedMs });
    }
  }

  const outPath = "/tmp/r4b-cost-results.json";
  await writeFile(outPath, JSON.stringify(results, null, 2));
  const ok = results.filter((r) => !r.error).length;
  console.log(`\n→ wrote ${results.length} result(s) (${ok} succeeded) to ${outPath}`);
}

main().catch((err) => {
  console.error("cost-measure failed:", err?.message ?? err);
  process.exit(1);
});
