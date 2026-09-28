/**
 * Step 2 — collapse every source into one Opportunity schema.
 * Field names differ across APIs and change without notice; if a source
 * shape shifts, this is the only file you need to fix.
 */
import "./_loadEnvLocal.mjs"; // honor scaffold/.env.local when run as plain `node`
import { readFile, writeFile } from "node:fs/promises";
import { normalizeGrantsRecord, normalizeSbirSolicitation } from "./lib/normalizeGrants.mjs";

const read = async (p, fallback = []) => {
  try { return JSON.parse(await readFile(p, "utf8")); } catch { return fallback; }
};

const grants = await read("data/raw/grants.json");
const sols = await read("data/raw/sbir-solicitations.json");
const awards = await read("data/raw/sbir-awards.json");

/**
 * grants.gov agency names are sub-agency/office level ("Army Contracting
 * Command Rock Island", "Office of Science", "National Institute of
 * Standards and Technology"); SBIR award data uses top-level department
 * names ("Department of Defense", "Department of Energy"). A naive
 * substring/prefix match between the two essentially never hits. Bucket
 * both sides down to a canonical department key instead.
 */
const AGENCY_BUCKETS = [
  [/national science foundation|\bnsf\b/i, "NSF"],
  [/national institutes of health|\bnih\b/i, "HHS"],
  [/health and human services|\bhhs\b|centers for disease control|\bcdc\b|food and drug administration|\bfda\b|health resources and services|indian health service|administration for children/i, "HHS"],
  [/department of defense|\bdod\b|\barmy\b|\bnavy\b|air force|\bdarpa\b|defense advanced research|defense health agency|naval|marine corps|space force|missile defense/i, "DOD"],
  [/national aeronautics and space|\bnasa\b/i, "NASA"],
  [/department of energy|\bdoe\b|office of science|advanced research projects agency.?energy|\barpa-?e\b/i, "DOE"],
  [/environmental protection agency|\bepa\b/i, "EPA"],
  [/homeland security|\bdhs\b|cybersecurity and infrastructure|\bcisa\b/i, "DHS"],
  [/department of commerce|national institute of standards|\bnist\b|national telecommunications|\bntia\b|economic development administration/i, "DOC"],
  [/small business administration|\bsba\b/i, "SBA"],
  [/department of labor|\bdol\b|employment and training administration/i, "DOL"],
  [/department of education\b/i, "ED"],
  [/department of agriculture|\busda\b|national institute of food and agriculture/i, "USDA"],
  [/department of transportation|\bfaa\b|federal aviation/i, "DOT"],
  [/department of the interior|geological survey|\busgs\b/i, "DOI"],
  [/department of housing|\bhud\b/i, "HUD"],
  [/department of veterans affairs|\bva\b\W*medical/i, "VA"],
];
const agencyKey = (name) => {
  const n = name ?? "";
  for (const [re, key] of AGENCY_BUCKETS) if (re.test(n)) return key;
  return null;
};

const opportunities = [
  ...grants.map(normalizeGrantsRecord),
  ...sols.map(normalizeSbirSolicitation),
];

// Deduplicate and drop anything with no usable description to embed.
const seen = new Set();
const clean = opportunities.filter((o) => {
  if (!o.description || o.description.length < 60) return false;
  if (seen.has(o.id)) return false;
  seen.add(o.id);
  return true;
});

await writeFile("data/opportunities.json", JSON.stringify(clean, null, 2));

/**
 * Award history, keyed by opportunity id. `awards` rows are the SBIR bulk
 * CSV export (see 1-fetch.mjs), already pre-filtered to our keyword domains
 * plus Utah recipients. Department bucket (agencyKey) narrows the candidate
 * pool; within that pool we rank by real topic overlap instead of taking
 * CSV insertion order, so unrelated companies don't get surfaced just
 * because they share a department with the opportunity.
 *
 * Domain keyword list — mirrors KEYWORDS in 1-fetch.mjs (kept as a literal
 * copy, not a shared import, so this normalization step stays standalone).
 * These are multi-word/compound phrases specific enough that a shared hit
 * is a genuine topical signal — unlike single-word token overlap, which
 * false-positives on generic grant-speak ("system", "control", "development").
 * Recomputing this against the opportunity's own text (rather than trusting
 * o.industryTags) matters because the dedup above only keeps the FIRST
 * keyword search that surfaced a given grants.gov id, so industryTags alone
 * under-counts what the opportunity is actually about.
 */
const DOMAIN_KEYWORDS = [
  "artificial intelligence", "health information technology", "nursing workforce",
  "advanced manufacturing", "aerospace materials", "lightweight structures",
  "water infrastructure", "environmental sensors", "climate technology",
  "cybersecurity", "threat detection", "small business innovation",
  "workforce development", "youth programs", "community development",
];
// "small business innovation" is the SBIR/STTR *funding mechanism*, not an
// industry vertical — nearly every SBIR opportunity and award title contains
// it, so it should still count toward ranking (mechanism relevance) but must
// NOT by itself make a company "same vertical" as the opportunity.
const MECHANISM = new Set(["small business innovation"]);
const STOPWORDS = new Set([
  "the", "and", "for", "with", "from", "this", "that", "are", "was", "were",
  "will", "into", "their", "our", "your", "have", "has", "not", "who", "such",
  "than", "then", "also", "any", "all", "may", "can", "each", "other",
  "these", "those", "over", "under", "more", "most", "some", "about",
  "program", "project", "phase", "sbir", "sttr", "award",
]);
const tokenize = (text) =>
  (text ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 3 && !STOPWORDS.has(w));

const byOpp = {};
for (const o of clean) {
  const oKey = agencyKey(o.agency);
  if (!oKey) continue;
  const rel = awards.filter((a) => agencyKey(a.agency) === oKey);
  if (rel.length === 0) continue;

  const oText = `${o.program} ${o.description}`.toLowerCase();
  const oKeywords = new Set(DOMAIN_KEYWORDS.filter((k) => oText.includes(k)));
  const oTokens = new Set(tokenize(oText));

  const scored = rel.map((a) => {
    const awardKeywords = a._keywords ?? [];
    const keywordOverlap = awardKeywords.filter((k) => oKeywords.has(k)).length;
    // Same overlap, but with mechanism phrases (e.g. "small business
    // innovation") excluded — used only to decide sameVertical, so sharing
    // the SBIR mechanism doesn't count as sharing an industry vertical.
    const domainOverlap = awardKeywords.filter((k) => oKeywords.has(k) && !MECHANISM.has(k)).length;
    const aTokens = tokenize(`${a.award_title} ${awardKeywords.join(" ")}`);
    const tokenOverlap = aTokens.filter((t) => oTokens.has(t)).length;
    // Keyword overlap (curated, multi-word, low false-positive rate) always
    // outranks token overlap; token overlap only breaks ties within a tier.
    return { a, domainOverlap, rank: keywordOverlap * 100 + tokenOverlap };
  });
  scored.sort((x, y) => y.rank - x.rank || (Number(y.a.award_amount) || 0) - (Number(x.a.award_amount) || 0));

  const seenFirms = new Set();
  const rows = [];
  for (const { a, domainOverlap } of scored) {
    const amount = Number(a.award_amount) || 0;
    if (amount <= 0) continue;
    const company = (a.firm ?? "Unknown").trim();
    if (seenFirms.has(company)) continue; // dedup repeated firms per opportunity
    seenFirms.add(company);
    rows.push({
      company,
      program: (a.program ?? "SBIR").trim(),
      agency: (a.agency ?? "").trim(),
      amount,
      year: Number(a.award_year) || 0,
      state: (a.state ?? "").trim(),
      sameVertical: domainOverlap > 0,
    });
    if (rows.length >= 12) break;
  }
  if (rows.length > 0) byOpp[o.id] = rows;
}
await writeFile("data/awards.json", JSON.stringify(byOpp, null, 2));

console.log(`→ ${clean.length} normalized opportunities`);
console.log(`→ award history for ${Object.keys(byOpp).length} of them`);
console.log("Next: npm run data:embed");
