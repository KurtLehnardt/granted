/**
 * MVP data-breadth — the single ATOMIC assembly step.
 *
 * 1-fetch-sam-assistance writes ONLY its own raw file. THIS is the one place
 * that combines it into data/opportunities.json — so parallel fetchers
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
 *
 * Embedding matches 3-embed.mjs exactly (text-embedding-3-small, dimensions:512,
 * rounded to 5 decimals) so new vectors are comparable to the user query
 * embedded at request time by lib/embed.ts.
 *
 * Run AFTER the fetcher: `node scripts/assemble-mvp-corpus.mjs`
 */
import "./_loadEnvLocal.mjs"; // honor scaffold/.env.local when run as plain `node`
import { readFile, writeFile } from "node:fs/promises";
import { normalizeSamRow } from "./lib/normalizeNewSources.mjs";

const KEY = process.env.OPENAI_API_KEY;
if (!KEY) {
  console.error("OPENAI_API_KEY is not set. Add it to .env.local (or your environment).");
  process.exit(1);
}

const read = async (p, fallback = []) => {
  try { return JSON.parse(await readFile(p, "utf8")); } catch { return fallback; }
};

// ---- Load the existing (already-embedded) corpus and the new raw sources ----
const existing = await read("data/opportunities.json");
const existingIds = new Set(existing.map((o) => o.id));
const sam = await read("data/raw/sam-assistance.json");

const newRecords = sam.map(normalizeSamRow).filter(Boolean);

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
console.log("Next: PORT=<dev-port> npm run data:precompute  (re-freeze the 4 demo cases)");
