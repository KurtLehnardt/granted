/**
 * MVP data-breadth — the single ATOMIC assembly step.
 *
 * The three new fetchers (1-fetch-sam-assistance / 1-fetch-sbir-corpus /
 * 1-fetch-procurement) each write ONLY their own raw file. THIS is the one place
 * that combines every source into data/opportunities.json — so parallel fetchers
 * never collide on the corpus (plan: "fetchers write their own raw files; one
 * assembly step regenerates opportunities.json").
 *
 * ADDITIVE ON PURPOSE: the 476 grants.gov opportunities already in
 * data/opportunities.json are ALREADY embedded (512-dim, baked at build time).
 * Re-fetching/re-embedding them would (a) burn embedding spend, (b) risk the
 * flaky grants.gov detail endpoint silently changing the 476-set. So we PRESERVE
 * them byte-for-byte and only normalize + embed the NEW records, then append.
 *
 * New records normalize into the A0 taxonomy:
 *   SAM assistance   → source:"assistance-listings", kind: assistance|loan|scholarship (evergreen: no deadline, no funding)
 *   SBIR             → source:"sbir",               kind:"rd"          (ongoing SBIR/STTR; honest "recent award" framing)
 *   USAspending      → source:"usaspending",        kind:"procurement" (gov-as-customer; a past contract, no deadline)
 *
 * Embedding matches 3-embed.mjs exactly (text-embedding-3-small, dimensions:512,
 * rounded to 5 decimals) so new vectors are comparable to the founder query
 * embedded at request time by lib/embed.ts.
 *
 * Run AFTER the three fetchers: `node scripts/assemble-mvp-corpus.mjs`
 */
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";

const KEY = process.env.OPENAI_API_KEY;
if (!KEY) {
  console.error("OPENAI_API_KEY is not set. Add it to .env.local (or your environment).");
  process.exit(1);
}

const read = async (p, fallback = []) => {
  try { return JSON.parse(await readFile(p, "utf8")); } catch { return fallback; }
};

/** Light text cleanup — the new sources are largely plain text, but strip any
 *  stray tags and collapse whitespace so descriptions embed/read cleanly. */
const clean = (s) =>
  (s ?? "")
    .replace(/<\/?[a-zA-Z][^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const shortId = (s) => createHash("sha1").update(s).digest("hex").slice(0, 10);

// ---- Load the existing (already-embedded) corpus and the new raw sources ----
const existing = await read("data/opportunities.json");
const existingIds = new Set(existing.map((o) => o.id));
const sam = await read("data/raw/sam-assistance.json");
const sbir = await read("data/raw/sbir-corpus.json");
const procurement = await read("data/raw/usaspending-contracts.json");

const newRecords = [];

// ---- SAM.gov Assistance Listings (evergreen programs) ----
for (const p of sam) {
  const title = clean(p.title);
  if (!title) continue;
  const description = [title, clean(p.objectives), clean(p.uses)]
    .filter(Boolean).join(". ").slice(0, 4000);
  newRecords.push({
    id: `sam-${p.programNumber || shortId(title)}`,
    source: "assistance-listings",
    kind: p.kind, // assistance | loan | scholarship (set by the fetcher)
    program: title,
    agency: clean(p.agency) || "Federal agency",
    description,
    eligibility: clean(p.eligibility) || undefined,
    // Evergreen (I5): no deadline, no funding floor/ceiling. Status marks it as
    // a standing program so nothing reads "closing soon" or zeroes the summary.
    status: "continuous",
    forecasted: false,
    industryTags: p._keywords ?? [],
    url: clean(p.url) || clean(p.website) || undefined,
  });
}

// ---- SBIR/STTR (source:sbir, kind:rd) ----
for (const a of sbir) {
  const title = clean(a.title);
  if (!title) continue;
  const yr = a.year ? `FY${a.year}` : "recently";
  const framing =
    `Recent SBIR/STTR award (${yr})` +
    (a.state ? ` to a ${a.state} small business` : "") +
    `; ${clean(a.agency)} funds R&D in this area under its ongoing SBIR/STTR program.`;
  const description = [title, framing, clean(a.abstract)]
    .filter(Boolean).join(" ").slice(0, 4000);
  newRecords.push({
    id: `sbir-award-${shortId(`${a.company}|${a.year}|${title}`)}`,
    source: "sbir",
    kind: "rd",
    program: title,
    agency: clean(a.agency) || "SBIR/STTR agency",
    description,
    eligibility: "US small business, generally under 500 employees (SBIR/STTR).",
    // SBIR/STTR agencies solicit continuously; this record reflects a funded
    // topic area, not a dated solicitation — so no deadline (honest, per degrade
    // note in 1-fetch-sbir-corpus.mjs).
    status: "continuous",
    forecasted: false,
    industryTags: a._keywords ?? [],
    url: clean(a.website) || "https://www.sbir.gov/awards",
  });
}

// ---- USAspending contract awards (kind:procurement, gov-as-customer) ----
for (const c of procurement) {
  const recipient = clean(c["Recipient Name"]);
  const rawDesc = clean(c["Description"]);
  const naics = c["NAICS"] || {};
  const naicsDesc = clean(naics.description);
  const agency = clean(c["Awarding Agency"]) || "Federal agency";
  const subAgency = clean(c["Awarding Sub Agency"]) || agency;
  const amount = Number(c["Award Amount"]) || 0;
  const startDate = clean(c["Start Date"]);
  const program = (rawDesc || `${naicsDesc || "Federal"} contract`).slice(0, 120);
  const amountStr = amount ? `$${amount.toLocaleString("en-US")}` : "an undisclosed amount";
  const description = [
    rawDesc,
    `Federal ${naicsDesc ? `(${naicsDesc}) ` : ""}contract awarded to ${recipient || "a contractor"} for ${amountStr}` +
      (startDate ? ` (start ${startDate})` : "") + ".",
    `Government-as-customer signal: ${subAgency} buys in this area — this is a procurement / business-development path (government as a customer), not a grant. Verify current solicitations on SAM.gov.`,
  ].filter(Boolean).join(" ").slice(0, 4000);
  const internalId = clean(c.generated_internal_id);
  newRecords.push({
    id: `usasp-${clean(c["Award ID"]) || shortId(internalId || program)}`,
    source: "usaspending",
    kind: "procurement",
    program,
    agency,
    description,
    eligibility: "Open to firms able to perform the contract scope and holding the required registrations (active SAM.gov / UEI).",
    status: "closed", // a specific past award; the signal is the buying pattern
    forecasted: false,
    industryTags: [c._keyword, clean(naics.code)].filter(Boolean),
    url: internalId ? `https://www.usaspending.gov/award/${internalId}` : undefined,
  });
}

// ---- Dedup (never collide with an existing id; drop thin/dup new records) ----
const seen = new Set(existingIds);
const cleanNew = newRecords.filter((o) => {
  if (!o.description || o.description.length < 60) return false;
  if (seen.has(o.id)) return false;
  seen.add(o.id);
  return true;
});

// ---- Embed ONLY the new records (existing ones keep their baked embeddings) ----
const MODEL = "text-embedding-3-small";
const BATCH = 32;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function embedBatch(inputs, attempt = 0) {
  const res = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ model: MODEL, dimensions: 512, input: inputs }),
  });
  if (res.status === 429 || res.status >= 500) {
    if (attempt >= 7) throw new Error(`Gave up after ${attempt} retries (${res.status}): ${await res.text()}`);
    const ra = Number(res.headers.get("retry-after"));
    const wait = Number.isFinite(ra) && ra > 0 ? ra * 1000 : Math.min(60000, 1000 * 2 ** attempt);
    process.stdout.write(`\n  ${res.status} rate-limited — backing off ${Math.round(wait / 1000)}s (retry ${attempt + 1}/7)`);
    await sleep(wait);
    return embedBatch(inputs, attempt + 1);
  }
  if (!res.ok) throw new Error(`Embeddings failed (${res.status}): ${await res.text()}`);
  return (await res.json()).data;
}

if (cleanNew.length === 0) {
  console.warn("No new records to add — did the fetchers run? Leaving opportunities.json unchanged.");
  process.exit(0);
}

let done = 0;
for (let i = 0; i < cleanNew.length; i += BATCH) {
  const slice = cleanNew.slice(i, i + BATCH);
  const data = await embedBatch(slice.map((o) => `${o.program}. ${o.agency}. ${o.description}`.slice(0, 8000)));
  data.forEach((d, k) => {
    slice[k].embedding = d.embedding.map((v) => Math.round(v * 1e5) / 1e5);
  });
  done += slice.length;
  process.stdout.write(`\rembedded ${done}/${cleanNew.length} new records`);
  await sleep(400);
}
process.stdout.write("\n");

// ---- Combine (existing preserved first) and write ----
const combined = [...existing, ...cleanNew];
await writeFile("data/opportunities.json", JSON.stringify(combined));

const kinds = {};
const sources = {};
for (const o of combined) {
  kinds[o.kind] = (kinds[o.kind] || 0) + 1;
  sources[o.source] = (sources[o.source] || 0) + 1;
}
console.log(`\n→ corpus assembled: ${combined.length} opportunities (${existing.length} existing + ${cleanNew.length} new)`);
console.log("  by kind:  ", JSON.stringify(kinds));
console.log("  by source:", JSON.stringify(sources));
console.log("Next: PORT=<dev-port> npm run data:precompute  (re-freeze the 5 demo cases)");
