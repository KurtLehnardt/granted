/**
 * Step 5 — Competitor & Grant Intelligence example capture (R5).
 *
 * A ONE-OFF capture, NOT a request-time route. It runs the SAME engine the live
 * `/api/competitors` route uses (lib/competitors/analyze.ts), so a captured
 * example and the live path can never drift:
 *
 *   1. RETRIEVE real awardee records from the keyless federal sources proven in
 *      docs/competitor-grant-analysis-feasibility.md §2 — USAspending, NIH
 *      RePORTER, NSF (fault-tolerant: a source that fails is skipped).
 *   2. RERANK by cosine similarity to the persona (text-embedding-3-small @512).
 *   3. SYNTHESIZE grounded positioning feedback in ONE claude-sonnet-4-6 call
 *      (the registered `competitorAnalysis` prompt). Every claim cites retrieved
 *      evidence by id; the pipeline drops any invented id, then
 *      CompetitorAnalysisSchema.parse() THROWS on any survivor.
 *   4. WEB PROFILES: because EXA_API_KEY is not required at capture time, the
 *      canonical private-competitor profiles below were gathered once via the exa
 *      MCP (real companies, real URLs) and are passed in verbatim. They carry NO
 *      award amount.
 *   5. WRITE data/competitor-analysis-example.json (mode:"example").
 *
 * This spends a few cents of real OpenAI + Anthropic credit — authorized for the
 * capture. Run with the keys loaded:  `npm run data:competitors`.
 */
import { writeFile } from "node:fs/promises";
import { createCostMeter } from "../lib/metering/meter.ts";
import { analyzeCompetitors } from "../lib/competitors/analyze.ts";
import { CompetitorAnalysisSchema } from "../lib/contracts/competitorAnalysis.ts";

const PERSONA = "Acme QMS";
const PERSONA_DESCRIPTION =
  "Acme QMS is a Utah company building cloud-based quality management (QMS) and " +
  "manufacturing execution (MES) software for regulated life-sciences and manufacturing " +
  "customers. The platform handles electronic batch records, digital quality management, " +
  "deviation and CAPA workflows, and shop-floor manufacturing execution for companies that " +
  "must meet FDA and ISO quality requirements.";

/** Broad, gov-vocabulary keywords per source (over-narrow filters return []). */
const KEYWORDS = [
  "manufacturing execution system",
  "quality management system software",
  "smart manufacturing software",
  "digital quality management",
  "biomanufacturing quality control",
];

/**
 * REAL private competitors in Acme QMS's exact space, gathered once via the exa
 * MCP (category:company). Each has a real, clickable source URL and NO award —
 * they are context, never presented as federal awardees.
 */
const WEB_PROFILES = [
  {
    company: "SimplerQMS",
    sourceUrl: "https://simplerqms.com/",
    snippet:
      "Cloud-based life-science quality management software (eQMS) supporting GxP, ISO 13485:2016, " +
      "FDA 21 CFR Part 820 and Part 11, EU GMP Annex 11, EU MDR and IVDR. Founded 2017, Copenhagen.",
    via: "exa",
  },
  {
    company: "Cloudtheapp",
    sourceUrl: "https://cloudtheapp.com/",
    snippet:
      "AI-powered, fully validated, no-code eQMS for pharma, life sciences, medical device and " +
      "manufacturing — 45+ apps (CAPA, document control, batch records, deviations) on one audit-ready " +
      "platform, shipping FDA CSV validation packages. Founded 2018, Texas.",
    via: "exa",
  },
  {
    company: "SG Systems Global",
    sourceUrl: "https://sgsystemsglobal.com/",
    snippet:
      "Integrated MES, QMS and WMS software for regulated process manufacturing — batch execution, " +
      "electronic batch records (21 CFR Part 11), in-line quality control / SPC, and CAPA / NCR " +
      "management, connected to ERP and plant equipment. Founded 2006, Dallas.",
    via: "exa",
  },
  {
    company: "Litewave AI",
    sourceUrl: "https://litewave.ai/",
    snippet:
      "AI-native industrial operating system for regulated manufacturing — digitizes batch records, " +
      "quality documents and plant systems (MES, LIMS, QMS) for GxP environments aligned with 21 CFR " +
      "Part 11 and EU Annex 11.",
    via: "exa",
  },
];

async function main() {
  console.log(`Persona: ${PERSONA}`);
  console.log("[1-3] Running the shared analyze engine (retrieve -> rerank -> synthesize -> ground -> validate)…");
  const meter = createCostMeter();

  const analysis = await analyzeCompetitors({
    persona: PERSONA,
    personaDescription: PERSONA_DESCRIPTION,
    keywords: KEYWORDS,
    keepTopK: 8,
    perKeyword: 8,
    webProfilesOverride: WEB_PROFILES,
    mode: "example",
    meter,
  });

  const cost = meter.summary();
  const fixture = {
    ...analysis,
    cost: { totalCostUsd: Number(cost.totalCostUsd.toFixed(4)), pricingAsOf: cost.pricingAsOf },
  };

  // Belt-and-suspenders: re-validate the assembled fixture (with cost) through the
  // grounding contract — a hallucinated award/citation THROWS here.
  console.log("[4] Validating fixture through the grounding contract…");
  CompetitorAnalysisSchema.parse(fixture);

  await writeFile("data/competitor-analysis-example.json", JSON.stringify(fixture, null, 2));
  console.log(
    `[5] Wrote data/competitor-analysis-example.json — ${fixture.records.length} records, ` +
      `${(fixture.webProfiles ?? []).length} web profiles, ${fixture.analysis.competitors.length} competitors, ` +
      `${fixture.analysis.recommendations.length} recommendations, ` +
      `${(fixture.analysis.opportunities ?? []).length} opportunities, ~$${fixture.cost.totalCostUsd} spent.`,
  );
}

main().catch((err) => {
  console.error("Capture FAILED:", err?.message ?? err);
  process.exit(1);
});
