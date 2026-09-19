/**
 * Step 1 (MVP data-breadth) — SAM.gov Assistance Listings (the CFDA catalog).
 *
 * KEYLESS source: the public Federal Assistance Listings extract that SAM.gov
 * publishes to data.gov via the `falextracts` S3 bucket. No api.sam.gov / data.gov
 * key needed (that path is tabled as a nice-to-have for a future iteration).
 *
 * These are EVERGREEN PROGRAMS, not dated solicitations: most have NO application
 * deadline and NO award floor/ceiling. We deliberately DO NOT synthesize either —
 * the assembly step (assemble-mvp-corpus.mjs) normalizes them deadline-less and
 * funding-less so the card renders in "evergreen" mode instead of reading
 * "closing soon" or zeroing the summary (plan A0/I5).
 *
 * Writes ONLY its own raw file (data/raw/sam-assistance.json). It never touches
 * data/opportunities.json or the assembly — that keeps parallel fetchers from
 * colliding on the corpus (one atomic assembly step combines every source).
 *
 * Run on your laptop: `node scripts/1-fetch-sam-assistance.mjs`
 */
import { writeFile, mkdir } from "node:fs/promises";

await mkdir("data/raw", { recursive: true });

const FAL_URL =
  "https://falextracts.s3.amazonaws.com/Assistance%20Listings/datagov/AssistanceListings_DataGov_PUBLIC_CURRENT.csv";

/** Domains shaped around the five standard test cases + the breadth the brief
 *  asks for (loans / scholarships / assistance across the demo verticals). Kept
 *  as a standalone literal (like 2-normalize.mjs's copy) so this script needs no
 *  shared import. Multi-word phrases keep the false-positive rate low. */
const DOMAIN_KEYWORDS = [
  "artificial intelligence", "machine learning", "health information",
  "health care", "healthcare", "hospital", "nursing", "biomedical", "telehealth",
  "advanced manufacturing", "manufacturing", "aerospace", "materials",
  "semiconductor", "robotics",
  "water", "environmental", "climate", "clean energy", "renewable energy",
  "energy efficiency", "pollution",
  "cybersecurity", "cyber", "information security", "critical infrastructure",
  "small business", "entrepreneur", "innovation", "technology development",
  "research and development", "commercialization",
  "workforce", "apprenticeship", "job training", "career",
  "youth", "after school", "afterschool", "community development",
  "rural development", "economic development", "broadband",
  "scholarship", "fellowship", "traineeship", "education",
  "veteran", "minority", "disadvantaged business",
];

/** RFC4180-ish CSV parser (quoted fields, embedded commas/newlines). Mirrors the
 *  one in 1-fetch.mjs — copied, not imported, so this script stays standalone. */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field); field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      rows.push(row); row = [];
    } else {
      field += c;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

/** Classify a CFDA "Types of Assistance (060)" cell into our A0 taxonomy kind.
 *  Loans are their own kind; scholarship/fellowship programs are their own kind;
 *  everything else (project/formula grants, cooperative agreements, direct
 *  payments, training, technical assistance) normalizes to `assistance`. */
function classifyKind(typesOfAssistance, title) {
  const t = `${typesOfAssistance} ${title}`.toLowerCase();
  if (/\bloan\b|loan guarantee|guaranteed\/insured loan|direct loan/.test(t)) return "loan";
  if (/scholarship|fellowship|traineeship/.test(t)) return "scholarship";
  return "assistance";
}

/** Per-kind caps keep the corpus (and cold-start bundle) bounded AND stop the
 *  demo's case 5 from over-matching a flood of education/community listings.
 *  We still guarantee a healthy spread of every new kind. */
const CAPS = { assistance: 240, loan: 45, scholarship: 30 };

async function main() {
  console.log("SAM assistance  downloading FAL extract (~22MB, keyless)…");
  const res = await fetch(FAL_URL);
  if (!res.ok) throw new Error(`FAL extract HTTP ${res.status}`);
  const text = await res.text();
  const rows = parseCsv(text).filter((r) => r.length > 1);
  const header = rows[0];
  const col = (name) => header.indexOf(name);
  const iTitle = col("Program Title"), iNum = col("Program Number"),
    iAgency = col("Federal Agency (030)"), iObjectives = col("Objectives (050)"),
    iTypes = col("Types of Assistance (060)"), iUses = col("Uses and Use Restrictions (070)"),
    iElig = col("Applicant Eligibility (081)"), iDeadlines = col("Deadlines (094)"),
    iRange = col("Range and Average of Financial Assistance (123)"),
    iWebsite = col("Website Address (153)"), iUrl = col("URL");

  const out = [];
  const counts = { assistance: 0, loan: 0, scholarship: 0 };
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (r.length < header.length) continue;
    const title = (r[iTitle] ?? "").trim();
    const objectives = (r[iObjectives] ?? "").trim();
    if (!title) continue;
    const hay = `${title} ${objectives} ${r[iUses] ?? ""}`.toLowerCase();
    const matched = DOMAIN_KEYWORDS.filter((k) => hay.includes(k));
    if (matched.length === 0) continue;

    const kind = classifyKind(r[iTypes] ?? "", title);
    if (counts[kind] >= CAPS[kind]) continue;
    counts[kind]++;

    out.push({
      programNumber: (r[iNum] ?? "").trim(),
      title,
      agency: (r[iAgency] ?? "").trim(),
      objectives,
      typesOfAssistance: (r[iTypes] ?? "").trim(),
      uses: (r[iUses] ?? "").trim(),
      eligibility: (r[iElig] ?? "").trim(),
      deadlines: (r[iDeadlines] ?? "").trim(),
      financialRange: (r[iRange] ?? "").trim(),
      website: (r[iWebsite] ?? "").trim(),
      url: (r[iUrl] ?? "").trim(),
      kind,
      _keywords: matched.slice(0, 6),
    });
  }

  await writeFile("data/raw/sam-assistance.json", JSON.stringify(out, null, 2));
  console.log(`SAM assistance  kept ${out.length} of ${rows.length - 1} programs`);
  console.log(`  by kind: assistance=${counts.assistance} loan=${counts.loan} scholarship=${counts.scholarship}`);
  console.log("→ data/raw/sam-assistance.json\n");
}

await main();
