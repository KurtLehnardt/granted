/**
 * Step 1 — pull raw data from the government APIs into data/raw/.
 * Run on your laptop; these hosts are the slow, flaky part of the whole build.
 * Nothing here runs at request time.
 */
import "./_loadEnvLocal.mjs"; // honor scaffold/.env.local when run as plain `node`
import { writeFile, mkdir } from "node:fs/promises";

await mkdir("data/raw", { recursive: true });

/** Keywords shaped around the five standard test cases. Widen if you add cases. */
const KEYWORDS = [
  "artificial intelligence", "health information technology", "nursing workforce",
  "advanced manufacturing", "aerospace materials", "lightweight structures",
  "water infrastructure", "environmental sensors", "climate technology",
  "cybersecurity", "threat detection", "small business innovation",
  "workforce development", "youth programs", "community development",
];

/** Simple bounded-concurrency runner — grants.gov's detail endpoint is slow
 * one-at-a-time but doesn't like being hammered unbounded either. */
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: limit }, worker));
  return results;
}

/** RFC4180-ish CSV parser (quoted fields, embedded commas/newlines). Used for
 * the SBIR bulk award export, which has no JSON equivalent that's reachable
 * right now (see sbir() below). */
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

async function grantsGov() {
  const out = [];
  for (const kw of KEYWORDS) {
    try {
      const res = await fetch("https://api.grants.gov/v1/api/search2", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rows: 50, keyword: kw, oppStatuses: "forecasted|posted" }),
      });
      const json = await res.json();
      const hits = json?.data?.oppHits ?? [];
      out.push(...hits.map((h) => ({ ...h, _keyword: kw })));
      console.log(`grants.gov  ${kw.padEnd(32)} ${hits.length}`);
    } catch (e) {
      console.warn(`grants.gov  ${kw} FAILED — ${e.message}`);
    }
    await new Promise((r) => setTimeout(r, 250));
  }

  // search2 only returns search-hit summaries: id/number/title/agency/
  // agencyCode/openDate/closeDate/oppStatus/docType/cfdaList. There is NO
  // synopsis, eligibility text, or award amount in that response at all —
  // 2-normalize.mjs cannot get real descriptions without a second call per
  // opportunity. fetchOpportunity returns a `synopsis` object for posted
  // opportunities or a `forecast` object for forecasted ones; both shapes
  // are passed through untouched as `_detail` so 2-normalize.mjs (the one
  // file responsible for interpreting source shapes) decides how to read
  // them.
  const uniqueIds = [...new Set(out.map((o) => o.id).filter(Boolean))];
  console.log(`grants.gov  fetching detail for ${uniqueIds.length} unique opportunities...`);
  let doneDetail = 0;
  const pairs = await mapWithConcurrency(uniqueIds, 8, async (id) => {
    let detail = null;
    try {
      const res = await fetch("https://api.grants.gov/v1/api/fetchOpportunity", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ opportunityId: Number(id) }),
      });
      if (res.ok) {
        const json = await res.json();
        detail = json?.data?.synopsis ?? json?.data?.forecast ?? null;
      }
    } catch {
      detail = null;
    }
    doneDetail++;
    if (doneDetail % 50 === 0) process.stdout.write(`\r  detail ${doneDetail}/${uniqueIds.length}`);
    return [id, detail];
  });
  process.stdout.write(`\r  detail ${doneDetail}/${uniqueIds.length}\n`);
  const detailById = new Map(pairs.filter(([, d]) => d));
  let withDetail = 0;
  for (const o of out) {
    const d = detailById.get(o.id);
    if (d) { o._detail = d; withDetail++; }
  }
  console.log(`grants.gov  ${withDetail}/${out.length} records got full detail`);

  await writeFile("data/raw/grants.json", JSON.stringify(out, null, 2));
  console.log(`\n→ ${out.length} grants.gov records\n`);
}

async function sbir() {
  const out = [];
  // Solicitations: as of this run, api.www.sbir.gov returns 403 Forbidden on
  // every variant we tried (bare, open=1, agency=, keyword=) — this matches
  // SBIR.gov's own posted notice that its public APIs are "currently
  // undergoing maintenance" (checked live + via web search, Aug 2026). Left
  // in place so it self-heals automatically if the outage clears before the
  // demo; the Array.isArray guard prevents the "Spread syntax requires
  // ...iterable" crash that a 403's {"message":"Forbidden"} body caused.
  try {
    const res = await fetch("https://api.www.sbir.gov/public/api/solicitations?open=1&rows=200");
    const json = await res.json();
    if (Array.isArray(json)) {
      out.push(...json);
      console.log(`sbir solicitations ${out.length}`);
    } else {
      console.warn(`sbir solicitations UNAVAILABLE (non-array response — likely the site's maintenance outage): ${JSON.stringify(json).slice(0, 200)}`);
    }
  } catch (e) {
    console.warn(`sbir solicitations FAILED — ${e.message}`);
  }
  await writeFile("data/raw/sbir-solicitations.json", JSON.stringify(out, null, 2));

  // Historical awards: the awards API is down for the same reason. Pull the
  // public bulk CSV export instead — data.www.sbir.gov is a different host
  // than the blocked api.www.sbir.gov and is unaffected — then filter locally
  // to our keyword domains plus Utah recipients (the ~91MB file has ~220k
  // rows across every SBIR award ever made; keeping all of them would bury
  // "similar companies funded" in irrelevant noise).
  const awards = [];
  try {
    const res = await fetch("https://data.www.sbir.gov/mod_awarddatapublic_no_abstract/award_data_no_abstract.csv");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    const rows = parseCsv(text).filter((r) => r.length > 1);
    const header = rows[0];
    const col = (name) => header.indexOf(name);
    const iCompany = col("Company"), iTitle = col("Award Title"), iAgency = col("Agency"),
      iBranch = col("Branch"), iProgram = col("Program"), iAmount = col("Award Amount"),
      iYear = col("Award Year"), iState = col("State");
    const kwLower = KEYWORDS.map((k) => k.toLowerCase());
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      if (r.length < header.length) continue;
      const title = (r[iTitle] ?? "").toLowerCase();
      const state = r[iState] ?? "";
      const matched = kwLower.filter((k) => title.includes(k));
      const isUtah = state.trim().toLowerCase() === "utah";
      if (matched.length === 0 && !isUtah) continue;
      awards.push({
        firm: r[iCompany],
        award_title: r[iTitle],
        agency: r[iAgency],
        branch: r[iBranch],
        program: r[iProgram],
        award_amount: r[iAmount],
        award_year: r[iYear],
        state,
        _keywords: matched,
      });
    }
    console.log(`sbir awards (bulk CSV, keyword+UT filtered) ${awards.length} of ${rows.length - 1} total rows`);
  } catch (e) {
    console.warn(`sbir awards bulk CSV FAILED — ${e.message}`);
  }
  await writeFile("data/raw/sbir-awards.json", JSON.stringify(awards, null, 2));
  console.log(`\n→ ${awards.length} SBIR award records\n`);
}

async function usaspending() {
  // Utah recipients, recent years — keeps the pull small and the demo local.
  const body = {
    filters: {
      time_period: [{ start_date: "2021-01-01", end_date: "2026-08-01" }],
      award_type_codes: ["02", "03", "04", "05"],
      place_of_performance_locations: [{ country: "USA", state: "UT" }],
    },
    fields: ["Award ID", "Recipient Name", "Awarding Agency", "Award Amount", "Start Date"],
    page: 1,
    limit: 100,
    sort: "Award Amount",
    order: "desc",
  };
  try {
    const res = await fetch("https://api.usaspending.gov/api/v2/search/spending_by_award/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = await res.json();
    await writeFile("data/raw/usaspending.json", JSON.stringify(json?.results ?? [], null, 2));
    console.log(`→ ${json?.results?.length ?? 0} USAspending records\n`);
  } catch (e) {
    console.warn(`usaspending FAILED — ${e.message}`);
    await writeFile("data/raw/usaspending.json", "[]");
  }
}

await grantsGov();
await sbir();
await usaspending();
console.log("Raw data in data/raw/. Next: npm run data:normalize");
