/**
 * Step 1 (state breadth) — North Carolina grant-opportunities directory.
 *
 * KEYLESS source: no API/CSV export exists (confirmed) -- this is a hand-rolled
 * HTML table-row scraper against the one central NC.gov directory page. Static
 * server-rendered HTML, no login, no JS rendering needed.
 *
 * GENUINELY SHALLOW SOURCE: confirmed live, the index has only Category /
 * Grant Program (external link) / Agency / Description -- no deadline, no
 * award amount, no eligibility at all. The normalizer deliberately leaves
 * those fields undefined rather than guessing; this is an honest data-
 * coverage ceiling, not a bug (see normalizeNcRow in normalizeNewSources.mjs).
 *
 * Writes ONLY its own raw file (data/raw/nc-grants.json), same convention as
 * every other fetcher.
 *
 * Run on your laptop: `node scripts/1-fetch-nc-grants.mjs`
 */
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

const RAW_DIR = process.env.RAW_DIR || "data/raw";
const rawPath = (name) => join(RAW_DIR, name);

await mkdir(RAW_DIR, { recursive: true });

const URL = "https://www.nc.gov/your-government/all-nc-state-services/grant-opportunities";

// Matches one <tr><td>Category</td><td><a href="URL">Title</a></td><td>Agency</td><td>Description</td></tr>
// row inside the page's one <tbody>. Confirmed live: flat structure, no
// nested tables, no multi-line cell content.
const ROW_RE = /<tr><td>(.*?)<\/td><td><a href="(.*?)">(.*?)<\/a><\/td><td>(.*?)<\/td><td>(.*?)<\/td><\/tr>/gs;

async function main() {
  console.log("NC grants  downloading North Carolina grant-opportunities directory (keyless HTML scrape)…");
  const res = await fetch(URL);
  if (!res.ok) throw new Error(`NC grants directory HTTP ${res.status}`);
  const html = await res.text();

  const tbodyStart = html.indexOf("<tbody");
  const tbodyEnd = html.indexOf("</tbody>", tbodyStart);
  if (tbodyStart === -1 || tbodyEnd === -1) throw new Error("NC grants directory: <tbody> not found -- page markup may have changed");
  const tbody = html.slice(tbodyStart, tbodyEnd);

  const out = [];
  for (const m of tbody.matchAll(ROW_RE)) {
    const [, category, url, title, agency, description] = m;
    if (!title) continue;
    out.push({ category, url, title, agency, description });
  }

  // No prior-run baseline exists for this brand-new source, so a silent scrape
  // break (the state changes its table markup) has nothing else to catch it.
  if (out.length < 20) {
    console.warn(`NC grants  WARNING: only parsed ${out.length} rows -- expected ~80+. The page markup may have changed.`);
  }

  await writeFile(rawPath("nc-grants.json"), JSON.stringify(out, null, 2));
  console.log(`NC grants  kept ${out.length} opportunities`);
  console.log(`→ ${rawPath("nc-grants.json")}\n`);
}

await main();
