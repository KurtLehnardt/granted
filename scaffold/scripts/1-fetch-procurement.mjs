/**
 * Step 1 (MVP data-breadth) — Procurement / "government as customer".
 *
 * KEYLESS source: USAspending contract awards (award_type_codes A–D). No key.
 * These become `kind:"procurement"`, `source:"usaspending"` records. They are
 * historical contract awards, used to answer "does the government BUY what we
 * build?" — a different value proposition than a grant (framed honestly by the
 * assembly + C2 whyCare as strategic/gov-as-customer, per plan N1), NOT dressed
 * up as an open solicitation (no fabricated deadline).
 *
 * Writes ONLY its own raw file (data/raw/usaspending-contracts.json).
 *
 * Run on your laptop: `node scripts/1-fetch-procurement.mjs`
 */
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

const RAW_DIR = process.env.RAW_DIR || "data/raw";
const rawPath = (name) => join(RAW_DIR, name);

await mkdir(RAW_DIR, { recursive: true });

const ENDPOINT = "https://api.usaspending.gov/api/v2/search/spending_by_award/";
const FIELDS = [
  "Award ID", "Recipient Name", "Awarding Agency", "Awarding Sub Agency",
  "Award Amount", "Start Date", "Description", "NAICS", "generated_internal_id",
];
const TIME = [{ start_date: "2022-01-01", end_date: "2026-08-01" }];
const CONTRACT_CODES = ["A", "B", "C", "D"];

/** Keyword pulls shaped around the five demo cases (national scope) + one Utah
 *  place-of-performance pull for locality. Each is capped small so no single
 *  domain dominates and the corpus stays cold-start friendly. */
const KEYWORD_QUERIES = [
  "cybersecurity", "artificial intelligence", "advanced manufacturing",
  "aerospace", "water treatment", "environmental monitoring",
  "health information technology",
];
const PER_QUERY = Number(process.env.PROCUREMENT_PER_QUERY) || 12;
const UTAH_LIMIT = Number(process.env.PROCUREMENT_UTAH_LIMIT) || 20;

async function search(filters, limit) {
  const body = { filters, fields: FIELDS, page: 1, limit, sort: "Award Amount", order: "desc" };
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  return json?.results ?? [];
}

async function main() {
  const byId = new Map();
  const add = (rows, keyword) => {
    for (const r of rows) {
      const id = r["Award ID"] || r.generated_internal_id;
      if (!id || byId.has(id)) continue;
      // Skip the mega-primes — a $13B missile contract isn't a useful "gov as
      // customer" signal for a startup; keep awards in a startup-relevant band.
      const amt = Number(r["Award Amount"]) || 0;
      if (amt <= 0 || amt > 75_000_000) continue;
      byId.set(id, { ...r, _keyword: keyword });
    }
  };

  for (const kw of KEYWORD_QUERIES) {
    try {
      const rows = await search(
        { time_period: TIME, award_type_codes: CONTRACT_CODES, keywords: [kw] },
        PER_QUERY,
      );
      add(rows, kw);
      console.log(`procurement  ${kw.padEnd(32)} ${rows.length}`);
    } catch (e) {
      console.warn(`procurement  ${kw} FAILED — ${e.message}`);
    }
    await new Promise((r) => setTimeout(r, 250));
  }

  try {
    const rows = await search(
      {
        time_period: TIME, award_type_codes: CONTRACT_CODES,
        place_of_performance_locations: [{ country: "USA", state: "UT" }],
      },
      UTAH_LIMIT,
    );
    add(rows, "utah");
    console.log(`procurement  ${"utah (place of performance)".padEnd(32)} ${rows.length}`);
  } catch (e) {
    console.warn(`procurement  utah FAILED — ${e.message}`);
  }

  const out = [...byId.values()];
  await writeFile(rawPath("usaspending-contracts.json"), JSON.stringify(out, null, 2));
  console.log(`\nprocurement  kept ${out.length} unique contract awards`);
  console.log("→ data/raw/usaspending-contracts.json\n");
}

await main();
