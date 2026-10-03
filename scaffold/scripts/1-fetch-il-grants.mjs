/**
 * Step 1 (state breadth) — Illinois Catalog of State Financial Assistance (CSFA).
 *
 * KEYLESS source: no API/CSV export exists (confirmed) -- this is a hand-rolled
 * HTML table-row scraper against the one live, statutorily-mandated central
 * opportunity list. Static server-rendered HTML (classic ASP.NET WebForms), no
 * login, no JS rendering needed -- confirmed by a plain fetch returning the
 * real 113-row table directly.
 *
 * IMPORTANT: use the plain host, not `www.` -- `www.omb.illinois.gov` failed
 * to connect during live verification; `omb.illinois.gov` works.
 *
 * Writes ONLY its own raw file (data/raw/il-grants.json), same convention as
 * every other fetcher.
 *
 * Run on your laptop: `node scripts/1-fetch-il-grants.mjs`
 */
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

const RAW_DIR = process.env.RAW_DIR || "data/raw";
const rawPath = (name) => join(RAW_DIR, name);

await mkdir(RAW_DIR, { recursive: true });

const URL = "https://omb.illinois.gov/public/gata/csfa/OpportunityList.aspx";

// Matches one <tr><td>..</td><td>..</td><td>..</td><td>..</td></tr> row.
// Confirmed live: the table has exactly these 4 columns, no nested tables
// inside a cell, no multi-line cell content -- a flat regex is safe here.
const ROW_RE = /<tr>\s*<td>(.*?)<\/td><td>(.*?)<\/td><td>(.*?)<\/td><td>(.*?)<\/td>\s*<\/tr>/gs;

/** First <td>'s content is either a GMS/AmpliFund redirect link (encoded url
 *  param) or an internal Opportunity.aspx?nofo=N link. Extract {title, url}. */
function parseTitleCell(cell) {
  const gms = cell.match(/<a href='GMS\.aspx\?url=([^&]+)&title=[^']*'[^>]*>(.*?)<\/a>/);
  if (gms) {
    return { title: gms[2], url: decodeURIComponent(gms[1]) };
  }
  const internal = cell.match(/<a href='Opportunity\.aspx\?nofo=(\d+)'>(.*?)<\/a>/);
  if (internal) {
    return { title: internal[2], url: `https://omb.illinois.gov/public/gata/csfa/Opportunity.aspx?nofo=${internal[1]}` };
  }
  return { title: null, url: null };
}

async function main() {
  console.log("IL grants  downloading Illinois CSFA opportunity list (keyless HTML scrape)…");
  const res = await fetch(URL);
  if (!res.ok) throw new Error(`Illinois CSFA HTTP ${res.status}`);
  const html = await res.text();

  const out = [];
  for (const m of html.matchAll(ROW_RE)) {
    const [, titleCell, agency, dateRange, awardRange] = m;
    const { title, url } = parseTitleCell(titleCell);
    if (!title) continue; // a row whose link pattern doesn't match either known shape -- skip, don't guess
    out.push({ title, url, agency, dateRange, awardRange });
  }

  // No prior-run baseline exists for this brand-new source, so a silent scrape
  // break (the state changes its table markup) has nothing else to catch it.
  if (out.length < 20) {
    console.warn(`IL grants  WARNING: only parsed ${out.length} rows -- expected ~100+. The page markup may have changed.`);
  }

  await writeFile(rawPath("il-grants.json"), JSON.stringify(out, null, 2));
  console.log(`IL grants  kept ${out.length} opportunities`);
  console.log(`→ ${rawPath("il-grants.json")}\n`);
}

await main();
