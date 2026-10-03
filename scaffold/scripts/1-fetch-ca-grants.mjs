/**
 * Step 1 (state breadth) — California Grants Portal.
 *
 * KEYLESS source: a real CKAN open-data dataset at data.ca.gov, the same
 * underlying dataset that powers grants.ca.gov, refreshed by the state daily.
 * No API key needed — standard CKAN `datastore_search`, paginated.
 *
 * Confirmed live (this session): resource id below, ~2,000 active records,
 * fields PortalID/GrantID/Status/LastUpdated/AgencyDept/Title/Type/
 * Categories/Purpose/Description/ApplicantType/ApplicantTypeNotes/Geography/
 * EstAvailFunds/EstAmounts/OpenDate/ApplicationDeadline/GrantURL.
 *
 * IMPORTANT: `GrantID` is null in most of the real data (confirmed live:
 * 1550/2017 records, 76.9%), and even the populated remainder is garbage
 * (agency names, not ids) — confirmed directly against live data. `PortalID`
 * is the reliable, always-populated key. Do NOT use GrantID as the id source.
 *
 * Writes ONLY its own raw file (data/raw/ca-grants.json), same convention as
 * every other fetcher — one atomic assembly step (refresh-corpus.mjs)
 * combines every source.
 *
 * Run on your laptop: `node scripts/1-fetch-ca-grants.mjs`
 */
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

const RAW_DIR = process.env.RAW_DIR || "data/raw";
const rawPath = (name) => join(RAW_DIR, name);

await mkdir(RAW_DIR, { recursive: true });

const RESOURCE_ID = "111c8c88-21f6-453c-ae2c-b4785a0624f5";
const PAGE_SIZE = 1000;
const BASE_URL = `https://data.ca.gov/api/3/action/datastore_search?resource_id=${RESOURCE_ID}`;

async function fetchPage(offset) {
  const res = await fetch(`${BASE_URL}&limit=${PAGE_SIZE}&offset=${offset}`);
  if (!res.ok) throw new Error(`CA grants portal HTTP ${res.status} (offset ${offset})`);
  const body = await res.json();
  if (!body.success) throw new Error(`CA grants portal returned success:false (offset ${offset})`);
  return body.result;
}

async function main() {
  console.log("CA grants  downloading California Grants Portal dataset (keyless CKAN API)…");
  // Confirmed live (this session): the large majority of records are
  // `closed` (1848 of 2017 in one check) -- carrying those through the
  // pipeline would just bloat data/raw and get dropped later for no benefit.
  // Filter to the two statuses that mean "still something to apply to" here,
  // at the source, same as every other fetcher's own domain/relevance filter.
  const LIVE_STATUSES = new Set(["active", "forecasted"]);
  const out = [];
  let offset = 0;
  let total = Infinity;
  let rawCount = 0;
  const statusCounts = {};
  const typeCounts = {};

  while (offset < total) {
    const page = await fetchPage(offset);
    total = page.total;
    for (const r of page.records) {
      rawCount++;
      statusCounts[r.Status] = (statusCounts[r.Status] ?? 0) + 1;
      if (!LIVE_STATUSES.has(r.Status)) continue;
      typeCounts[r.Type] = (typeCounts[r.Type] ?? 0) + 1;
      out.push(r);
    }
    offset += PAGE_SIZE;
    if (page.records.length === 0) break; // defensive: avoid an infinite loop on an unexpected empty page
  }

  await writeFile(rawPath("ca-grants.json"), JSON.stringify(out, null, 2));
  console.log(`CA grants  kept ${out.length} of ${rawCount} records (active/forecasted only)`);
  console.log(`  by status (all): ${JSON.stringify(statusCounts)}`);
  console.log(`  by type (kept): ${JSON.stringify(typeCounts)}`);
  console.log(`→ ${rawPath("ca-grants.json")}\n`);
}

await main();
