/**
 * Step 2 — collapse every source into one Opportunity schema.
 * Field names differ across APIs and change without notice; if a source
 * shape shifts, this is the only file you need to fix.
 */
import "./_loadEnvLocal.mjs"; // honor scaffold/.env.local when run as plain `node`
import { readFile, writeFile } from "node:fs/promises";

const read = async (p, fallback = []) => {
  try { return JSON.parse(await readFile(p, "utf8")); } catch { return fallback; }
};

const grants = await read("data/raw/grants.json");
const sols = await read("data/raw/sbir-solicitations.json");
const awards = await read("data/raw/sbir-awards.json");

/** grants.gov detail text (synopsisDesc / forecastDesc / applicantEligibilityDesc)
 * comes back as raw HTML (often Office-pasted markup). Strip tags/entities so
 * it embeds and reads cleanly. */
/** Common named entities seen in grants.gov HTML (Office-pasted markup uses
 * smart quotes/dashes/bullets far more than the handful this used to cover). */
const NAMED_ENTITIES = {
  nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'",
  rsquo: "’", lsquo: "‘", ldquo: "“", rdquo: "”",
  ndash: "–", mdash: "—", sect: "§", trade: "™",
  bull: "•", hellip: "…", copy: "©", reg: "®",
  atilde: "ã", eacute: "é", iacute: "í", ocirc: "ô",
};

// One decode pass: numeric entities (&#8239; / &#x2019; style — covers
// ligatures and exotic punctuation the named map doesn't list) then named.
const decodeEntitiesOnce = (s) =>
  s
    .replace(/&#x([0-9a-fA-F]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&([a-zA-Z]+);/g, (m, name) => NAMED_ENTITIES[name.toLowerCase()] ?? m);

// Only match real HTML tags (`<` or `</` immediately followed by a letter).
// A bare `<`/`>` used as a comparison operator (e.g. "< 500 employees") has
// no letter right after `<`, so it's left alone instead of being treated as
// an unclosed tag that swallows everything up to the next `>`.
const TAG_RE = /<\/?[a-zA-Z][^>]*>/g;

const stripHtml = (html) => {
  if (!html) return "";
  let text = html.replace(TAG_RE, " ");
  // grants.gov double-escapes some fields (e.g. "&amp;#64257;" — a literal
  // "&" HTML-escaped around an already-numeric entity). One decode pass
  // turns "&amp;" into "&", which unmasks a fresh "&#64257;" that a single
  // pass would miss. Loop (bounded) until a pass makes no further change.
  for (let i = 0; i < 3; i++) {
    const next = decodeEntitiesOnce(text);
    if (next === text) break;
    text = next;
  }
  // decoding can also unmask entities that were themselves escaped tags
  // (e.g. "&lt;br&gt;" -> "<br>"); strip once more to catch those.
  return text
    .replace(TAG_RE, " ")
    .replace(/\s+/g, " ")
    .trim();
};

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

const opportunities = [];

for (const g of grants) {
  const detail = g._detail ?? {};
  const title = stripHtml(g.title) || "Untitled opportunity";
  const descText = stripHtml(detail.synopsisDesc ?? detail.forecastDesc);
  const eligText = stripHtml(detail.applicantEligibilityDesc) ||
    stripHtml((detail.applicantTypes ?? []).map((t) => t.description).filter(Boolean).join("; "));
  opportunities.push({
    id: `grants-${g.id ?? g.number}`,
    source: "grants.gov",
    kind: "grant",
    program: title,
    agency: g.agency ?? g.agencyCode ?? "Unknown agency",
    description: [title, descText, g._keyword].filter(Boolean).join(". ").slice(0, 4000),
    eligibility: eligText,
    fundingLow: Number(detail.awardFloor) || undefined,
    fundingHigh: Number(detail.awardCeiling) || undefined,
    deadline: g.closeDate || undefined,
    forecasted: (g.oppStatus ?? "").toLowerCase() === "forecasted",
    industryTags: [g._keyword].filter(Boolean),
    url: g.id ? `https://www.grants.gov/search-results-detail/${g.id}` : undefined,
  });
}

for (const s of sols) {
  const solTitle = stripHtml(s.solicitation_title) || "SBIR/STTR solicitation";
  opportunities.push({
    id: `sbir-${s.solicitation_id ?? s.solicitation_number}`,
    source: "sbir",
    kind: "rd",
    program: solTitle,
    agency: s.agency ?? "Unknown agency",
    description: [solTitle, (s.solicitation_topics ?? [])
      .map((t) => `${stripHtml(t.topic_title)}: ${stripHtml(t.topic_description) ?? ""}`).join(" ")]
      .filter(Boolean).join(". ").slice(0, 4000),
    eligibility: "US small business, generally under 500 employees",
    deadline: s.close_date ?? undefined,
    url: s.solicitation_agency_url ?? undefined,
  });
}

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
