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
 * These are read from the environment OR from scaffold/.env.local (see the import
 * below), so the fully-local flow needs no inline env — just set the two vars in
 * scaffold/.env.local and run `npm run data:embed`.
 *
 * Fully-local example (Ollama nomic-embed-text, 768-dim) — in scaffold/.env.local:
 *   EMBEDDINGS_BASE_URL=http://localhost:11434/v1
 *   EMBEDDINGS_MODEL=nomic-embed-text
 *
 * --target=local (or npm run data:embed:local): re-embeds the corpus the app
 * actually loads (data/local/ if a data:refresh corpus exists, else the committed
 * snapshot) and writes it to the gitignored data/local/ — the same place
 * scripts/refresh-corpus.mjs writes and lib/corpus/store.ts prefers. Used by
 * setup-local.mjs so a fresh clone's re-embed never dirties the committed corpus.
 */
import "./_loadEnvLocal.mjs"; // honor scaffold/.env.local when run as plain `node`
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { corpusDims, embedOpportunities } from "./lib/embedCorpus.mjs";

const TARGET_LOCAL = process.argv.includes("--target=local");
const OUT_DIR = TARGET_LOCAL ? "data/local" : "data";
const IN_DIR = TARGET_LOCAL && existsSync("data/local/opportunities.json") ? "data/local" : "data";

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
  console.error("OPENAI_API_KEY is not set. Add it to .env.local (or your environment), or set EMBEDDINGS_BASE_URL to a local embedder (e.g. http://localhost:11434/v1) to run fully local.");
  process.exit(1);
}

const opps = JSON.parse(await readFile(`${IN_DIR}/opportunities.json`, "utf8"));

// The batch/retry loop lives in scripts/lib/embedCorpus.mjs, shared with the
// Settings-driven local re-embed (lib/embeddings/localEmbedJob.ts).
await embedOpportunities(opps, {
  baseUrl: BASE_URL,
  model: MODEL,
  dimensions: DIMENSIONS,
  key: KEY,
  batch: 32,
  interBatchDelayMs: IS_OPENAI ? 400 : 0, // gentle inter-batch pacing for the hosted API; unneeded locally
  onProgress: (n, total) => process.stdout.write(`\rembedded ${n}/${total}`),
  onRetry: ({ status, waitMs, attempt }) =>
    process.stdout.write(`\n  ${status} rate-limited — backing off ${Math.round(waitMs / 1000)}s (retry ${attempt}/7)`),
});
const done = opps.length;

if (TARGET_LOCAL) await mkdir(OUT_DIR, { recursive: true });
await writeFile(`${OUT_DIR}/opportunities.json`, JSON.stringify(opps));

// Data-freshness stamp: record WHEN this corpus was built so the app can
// surface "Opportunities as of <date>" and never present a point-in-time
// snapshot as if it were current (lib/corpus/meta.ts reads this). Embedding is
// the corpus's final in-place write and always runs on a (re)build, so it's the
// natural "built at" moment. `now` is the honest signal here — the corpus has
// no per-record retrieved_at, and its newest deadline is a sentinel, not a
// build time. A --target=local re-embed doesn't make the records newer, so it
// keeps the input corpus's stamp.
const inputMeta = TARGET_LOCAL ? JSON.parse(await readFile(`${IN_DIR}/corpus-meta.json`, "utf8").catch(() => "{}")) : {};
const builtAt = inputMeta.builtAt ?? new Date().toISOString();
await writeFile(
  `${OUT_DIR}/corpus-meta.json`,
  JSON.stringify(
    {
      builtAt,
      note: TARGET_LOCAL
        ? "Local re-embed (scripts/3-embed.mjs --target=local, e.g. via setup:local) — gitignored. builtAt is carried over from the input corpus. Read by lib/corpus/store.ts."
        : "When this committed opportunity snapshot was built (written by scripts/3-embed.mjs on every data:embed). Read by lib/corpus/meta.ts to surface an honest 'Opportunities as of <date>' caveat.",
      count: opps.length,
      embeddingModel: MODEL,
      dims: corpusDims(opps),
    },
    null,
    2,
  ) + "\n",
);

console.log(`\n→ ${done} programs embedded with ${MODEL} @ ${BASE_URL}`);
console.log(`→ ${OUT_DIR}/corpus-meta.json stamped builtAt=${builtAt}`);
console.log("Next: npm run dev — then npm run data:precompute once it works");
