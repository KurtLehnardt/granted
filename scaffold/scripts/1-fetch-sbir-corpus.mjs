/**
 * Step 1 (MVP data-breadth) — SBIR/STTR R&D records for the corpus.
 *
 * SBIR stays modeled as `source:"sbir"` + `kind:"rd"` (A0 — there is no `sbir`
 * kind). The open-solicitations API AND the solicitation bulk export both 403
 * right now (SBIR.gov maintenance; verified live). The keyless path that DOES
 * work is the public award bulk export on `data.www.sbir.gov` (a different host
 * than the blocked `api.www.sbir.gov`) — the WITH-abstract file, so each record
 * carries the real R&D abstract that embeds well.
 *
 * DEGRADE NOTE (honest): because open solicitations are unreachable, these are
 * recently-FUNDED SBIR/STTR awards, not open solicitations. The assembly step
 * describes them truthfully — "recent SBIR/STTR award; <agency> funds R&D in this
 * area under its ongoing SBIR/STTR program" — with NO fabricated deadline, so the
 * corpus honestly shows the SBIR/STTR R&D space (cases 1 & 4 want SBIR/STTR
 * visible) without dressing a closed award up as an open opportunity.
 *
 * Writes ONLY its own raw file (data/raw/sbir-corpus.json). Streaming-parses the
 * ~108MB export from disk so memory stays bounded.
 *
 * Run on your laptop: `node scripts/1-fetch-sbir-corpus.mjs`
 */
import { writeFile, mkdir, unlink } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";

await mkdir("data/raw", { recursive: true });

const CSV_URL = "https://data.www.sbir.gov/mod_awarddatapublic/award_data.csv";
const TMP = "data/raw/_sbir_abstract.csv.tmp";

const DOMAIN_KEYWORDS = [
  "artificial intelligence", "machine learning", "health information",
  "healthcare", "hospital", "nursing", "biomedical", "clinical",
  "advanced manufacturing", "manufacturing", "aerospace", "materials",
  "lightweight", "semiconductor", "robotics",
  "water", "environmental", "sensor", "climate", "energy",
  "cybersecurity", "cyber", "threat detection", "network security",
  "workforce", "autonomy", "autonomous",
];
const RECENT_MIN_YEAR = 2022;
const CAP_TOTAL = Number(process.env.SBIR_CAP_TOTAL) || 130;
const CAP_PER_AGENCY = Number(process.env.SBIR_CAP_PER_AGENCY) || 30;

/** Streaming RFC4180-ish parser: feed chunks, get complete rows via onRow.
 *  Bounds memory — we never hold the whole 108MB file as one array. */
function makeCsvParser(onRow) {
  let row = [];
  let field = "";
  let inQuotes = false;
  let prevCr = false;
  return {
    push(chunk) {
      for (let i = 0; i < chunk.length; i++) {
        const c = chunk[i];
        if (prevCr) { prevCr = false; if (c === "\n") continue; }
        if (inQuotes) {
          if (c === '"') {
            if (chunk[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
          } else field += c;
        } else if (c === '"') {
          inQuotes = true;
        } else if (c === ",") {
          row.push(field); field = "";
        } else if (c === "\n" || c === "\r") {
          if (c === "\r") prevCr = true;
          row.push(field); field = "";
          onRow(row); row = [];
        } else {
          field += c;
        }
      }
    },
    end() { if (field.length || row.length) { row.push(field); onRow(row); } },
  };
}

async function download() {
  console.log("SBIR corpus   downloading award export (~108MB, keyless)…");
  const res = await fetch(CSV_URL);
  if (!res.ok) throw new Error(`SBIR award export HTTP ${res.status}`);
  const { createWriteStream } = await import("node:fs");
  const fileStream = createWriteStream(TMP);
  await new Promise((resolve, reject) => {
    Readable.fromWeb(res.body).pipe(fileStream).on("finish", resolve).on("error", reject);
  });
}

async function main() {
  await download();

  let header = null;
  let idx = {};
  const out = [];
  const perAgency = {};
  const seenTitles = new Set();
  let scanned = 0;

  const parser = makeCsvParser((r) => {
    if (!header) {
      header = r;
      const col = (n) => header.indexOf(n);
      idx = {
        company: col("Company"), title: col("Award Title"), agency: col("Agency"),
        branch: col("Branch"), phase: col("Phase"), program: col("Program"),
        year: col("Award Year"), amount: col("Award Amount"), state: col("State"),
        abstract: col("Abstract"), topic: col("Topic Code"),
        solNum: col("Solicitation Number"), website: col("Company Website"),
      };
      return;
    }
    if (out.length >= CAP_TOTAL) return; // caps met — ignore the rest
    scanned++;
    if (r.length < header.length) return;
    const year = Number(r[idx.year]) || 0;
    if (year < RECENT_MIN_YEAR) return;
    const title = (r[idx.title] ?? "").trim();
    const abstract = (r[idx.abstract] ?? "").trim();
    if (!title || abstract.length < 120) return; // need real R&D text to embed
    const hay = `${title} ${abstract}`.toLowerCase();
    const matched = DOMAIN_KEYWORDS.filter((k) => hay.includes(k));
    if (matched.length === 0) return;
    const titleKey = title.toLowerCase().replace(/\s+/g, " ").slice(0, 80);
    if (seenTitles.has(titleKey)) return; // dedup near-identical award titles
    const agency = (r[idx.agency] ?? "").trim() || "SBIR/STTR agency";
    perAgency[agency] = perAgency[agency] ?? 0;
    if (perAgency[agency] >= CAP_PER_AGENCY) return; // spread across agencies
    perAgency[agency]++;
    seenTitles.add(titleKey);
    out.push({
      company: (r[idx.company] ?? "").trim(),
      title,
      agency,
      branch: (r[idx.branch] ?? "").trim(),
      phase: (r[idx.phase] ?? "").trim(),
      program: (r[idx.program] ?? "SBIR").trim(),
      year,
      amount: Number(r[idx.amount]) || undefined,
      state: (r[idx.state] ?? "").trim(),
      abstract: abstract.slice(0, 3500),
      topicCode: (r[idx.topic] ?? "").trim(),
      solicitationNumber: (r[idx.solNum] ?? "").trim(),
      website: (r[idx.website] ?? "").trim(),
      _keywords: matched.slice(0, 6),
    });
  });

  await new Promise((resolve, reject) => {
    const rs = createReadStream(TMP, { encoding: "utf8" });
    rs.on("data", (chunk) => parser.push(chunk));
    rs.on("end", () => { parser.end(); resolve(); });
    rs.on("error", reject);
  });

  await unlink(TMP).catch(() => {});
  await writeFile("data/raw/sbir-corpus.json", JSON.stringify(out, null, 2));
  console.log(`SBIR corpus   kept ${out.length} R&D records (scanned ${scanned}, ${Object.keys(perAgency).length} agencies, FY≥${RECENT_MIN_YEAR})`);
  console.log("→ data/raw/sbir-corpus.json\n");
}

await main();
