/**
 * Step 3 — embed every program description once, at build time, with the SAME
 * model/endpoint lib/embed.ts uses at request time (or the vectors aren't
 * comparable).
 *
 * --space picks the embedding space (scripts/lib/spaces.mjs):
 *
 *   --space=builtin   nomic-embed-text-v1.5, run in this process from scaffold/models/
 *                     (`npm run model:fetch` first). No key and no network. Writes
 *                     data/vectors/nomic-embed-text-v1.5.{f16.bin,json} and leaves
 *                     opportunities.json alone. Unchanged records keep their vectors.
 *   --space=openai    OpenAI text-embedding-3-small @ 512, stored inline in
 *                     opportunities.json (needs OPENAI_API_KEY).
 *   --space=custom    the EMBEDDINGS_BASE_URL / EMBEDDINGS_MODEL embedder, inline.
 *   (no --space)      openai, or custom when EMBEDDINGS_BASE_URL points elsewhere:
 *                     what this script always did.
 *
 * Env for the HTTP spaces:
 *   EMBEDDINGS_BASE_URL    OpenAI-compatible base  (default https://api.openai.com/v1)
 *   EMBEDDINGS_MODEL       model name              (default text-embedding-3-small)
 *   EMBEDDINGS_DIMENSIONS  OpenAI text-embedding-3-* only (512 matches the OpenAI corpus);
 *                          local models are fixed-size, so leave unset for them
 *   EMBEDDINGS_API_KEY     bearer token (falls back to OPENAI_API_KEY; Ollama ignores it)
 *
 * These are read from the environment OR from scaffold/.env.local (see the import
 * below).
 *
 * --target=local (or npm run data:embed:local): embeds the corpus the app
 * actually loads (data/local/ if a data:refresh corpus exists, else the committed
 * snapshot) and writes to the gitignored data/local/ — the same place
 * scripts/refresh-corpus.mjs writes and lib/corpus/store.ts prefers — so it never
 * dirties the committed corpus.
 */
import "./_loadEnvLocal.mjs"; // honor scaffold/.env.local when run as plain `node`
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { corpusDims, embedOpportunities } from "./lib/embedCorpus.mjs";
import { SPACES, hasCustomEmbedder } from "./lib/spaces.mjs";
import { buildSpaceVectors } from "./lib/spaceVectors.mjs";
import { readVectorFile, writeVectorFile } from "./lib/vectorFile.mjs";
import { BUILTIN_MODEL, builtinModelPresent, loadBuiltinEmbedder } from "./lib/builtinModel.mjs";

const TARGET_LOCAL = process.argv.includes("--target=local");
const OUT_DIR = TARGET_LOCAL ? "data/local" : "data";
const IN_DIR = TARGET_LOCAL && existsSync("data/local/opportunities.json") ? "data/local" : "data";

const spaceArg = process.argv.find((a) => a.startsWith("--space="))?.slice("--space=".length);
if (spaceArg && !SPACES[spaceArg]) {
  console.error(`Unknown --space=${spaceArg}. Use one of: ${Object.keys(SPACES).join(", ")}.`);
  process.exit(1);
}
const SPACE_ID = spaceArg ?? (hasCustomEmbedder(process.env.EMBEDDINGS_BASE_URL) ? "custom" : "openai");

if (SPACES[SPACE_ID].vectors.kind === "file") {
  await embedVectorFileSpace(SPACES[SPACE_ID]);
  process.exit(0);
}

/** --space=builtin: write the space's own vector file, reusing every vector whose id and text are unchanged. */
async function embedVectorFileSpace(space) {
  if (!builtinModelPresent()) {
    console.error("The built-in search model isn't in scaffold/models/ yet. Run `npm run model:fetch` first.");
    process.exit(1);
  }
  const opps = JSON.parse(await readFile(`${IN_DIR}/opportunities.json`, "utf8"));
  const vecDir = `${OUT_DIR}/vectors`;
  // A local run starts from the committed vectors, so only records a refresh changed get embedded.
  const prior =
    readVectorFile(vecDir, space.vectors.name) ?? (TARGET_LOCAL ? readVectorFile("data/vectors", space.vectors.name) : null);
  const embedder = await loadBuiltinEmbedder();
  const t0 = Date.now();
  const result = await buildSpaceVectors(space, opps, {
    prior: prior?.vectors,
    embed: embedder.embed,
    batch: 16,
    onProgress: (n, total) => process.stdout.write(`\rembedded ${n}/${total} (${Math.round((Date.now() - t0) / 1000)}s)`),
  });
  const meta = writeVectorFile(
    vecDir,
    space.vectors.name,
    { space: space.id, model: space.model, revision: BUILTIN_MODEL.revision, dims: space.dims },
    result.entries,
  );
  console.log(
    `\n→ ${meta.count} programs in ${vecDir}/${space.vectors.name}.f16.bin ` +
      `(${result.reused} reused, ${result.embedded} embedded with ${space.model})`,
  );
}

// --space=openai always means OpenAI's model, whatever EMBEDDINGS_BASE_URL says.
const FORCE_OPENAI = spaceArg === "openai";
const BASE_URL = (FORCE_OPENAI ? "https://api.openai.com/v1" : process.env.EMBEDDINGS_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
const MODEL = FORCE_OPENAI ? SPACES.openai.model : process.env.EMBEDDINGS_MODEL || "text-embedding-3-small";
const IS_OPENAI = /api\.openai\.com/.test(BASE_URL);
// OpenAI's text-embedding-3-* accept a `dimensions` param (512 matches the corpus);
// local models have a fixed size, so we omit it there unless explicitly set.
const DIMENSIONS = FORCE_OPENAI
  ? SPACES.openai.dims
  : process.env.EMBEDDINGS_DIMENSIONS
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

// The batch/retry loop for HTTP embedders lives in scripts/lib/embedCorpus.mjs.
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
