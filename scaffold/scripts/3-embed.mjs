/**
 * Step 3 — embed every program description once, at build time, with the SAME
 * model/endpoint lib/embed.ts uses at request time (or the vectors aren't
 * comparable). Honors the local-embedder env seam documented in lib/embed.ts:
 *
 *   EMBEDDINGS_BASE_URL    OpenAI-compatible base  (default https://api.openai.com/v1)
 *   EMBEDDINGS_MODEL       model name              (default text-embedding-3-small)
 *   EMBEDDINGS_DIMENSIONS  OpenAI text-embedding-3-* only (512 matches the OpenAI corpus);
 *                          local models are fixed-size, so leave unset for them
 *   EMBEDDINGS_API_KEY     bearer token (falls back to OPENAI_API_KEY; Ollama ignores it)
 *
 * Fully-local example (Ollama nomic-embed-text, 768-dim):
 *   EMBEDDINGS_BASE_URL=http://localhost:11434/v1 EMBEDDINGS_MODEL=nomic-embed-text npm run data:embed
 */
import { readFile, writeFile } from "node:fs/promises";

const BASE_URL = (process.env.EMBEDDINGS_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
const MODEL = process.env.EMBEDDINGS_MODEL || "text-embedding-3-small";
const IS_OPENAI = /api\.openai\.com/.test(BASE_URL);
// OpenAI's text-embedding-3-* accept a `dimensions` param (512 matches the corpus);
// local models have a fixed size, so we omit it there unless explicitly set.
const DIMENSIONS = process.env.EMBEDDINGS_DIMENSIONS
  ? Number(process.env.EMBEDDINGS_DIMENSIONS)
  : IS_OPENAI
    ? 512
    : undefined;
const KEY = process.env.EMBEDDINGS_API_KEY || process.env.OPENAI_API_KEY || "local";
if (IS_OPENAI && !process.env.EMBEDDINGS_API_KEY && !process.env.OPENAI_API_KEY) {
  console.error("OPENAI_API_KEY is not set. It's in your .zshrc (`source ~/.zshrc`), or set EMBEDDINGS_BASE_URL to a local embedder (e.g. http://localhost:11434/v1).");
  process.exit(1);
}

const opps = JSON.parse(await readFile("data/opportunities.json", "utf8"));
const BATCH = 32;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function embedBody(inputs) {
  return JSON.stringify(
    DIMENSIONS != null ? { model: MODEL, dimensions: DIMENSIONS, input: inputs } : { model: MODEL, input: inputs },
  );
}

/** POST one batch, retrying with exponential backoff on 429/5xx (honors Retry-After). */
async function embedBatch(inputs, attempt = 0) {
  const res = await fetch(`${BASE_URL}/embeddings`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
    body: embedBody(inputs),
  });

  if (res.status === 429 || res.status >= 500) {
    if (attempt >= 7) throw new Error(`Gave up after ${attempt} retries (${res.status}): ${await res.text()}`);
    const ra = Number(res.headers.get("retry-after"));
    const wait = Number.isFinite(ra) && ra > 0 ? ra * 1000 : Math.min(60000, 1000 * 2 ** attempt);
    process.stdout.write(`\n  ${res.status} rate-limited — backing off ${Math.round(wait / 1000)}s (retry ${attempt + 1}/7)`);
    await sleep(wait);
    return embedBatch(inputs, attempt + 1);
  }
  if (!res.ok) throw new Error(`Embeddings failed (${res.status}) at ${BASE_URL}: ${await res.text()}`);
  return (await res.json()).data;
}

let done = 0;
for (let i = 0; i < opps.length; i += BATCH) {
  const slice = opps.slice(i, i + BATCH);
  const data = await embedBatch(slice.map((o) => `${o.program}. ${o.agency}. ${o.description}`.slice(0, 8000)));
  data.forEach((d, k) => {
    slice[k].embedding = d.embedding.map((v) => Math.round(v * 1e5) / 1e5);
  });
  done += slice.length;
  process.stdout.write(`\rembedded ${done}/${opps.length}`);
  if (IS_OPENAI) await sleep(400); // gentle inter-batch pacing for the hosted API; unneeded locally
}

await writeFile("data/opportunities.json", JSON.stringify(opps));
console.log(`\n→ ${done} programs embedded with ${MODEL} @ ${BASE_URL}`);
console.log("Next: npm run dev — then npm run data:precompute once it works");
