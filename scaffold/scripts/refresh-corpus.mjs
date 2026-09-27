/**
 * npm run data:refresh — local, no-API-key corpus refresh. Local-LLM-first:
 * each install refreshes its OWN opportunity data into a gitignored local
 * copy (data/local/opportunities.json + corpus-meta.json), read at runtime
 * by lib/corpus/store.ts. The committed data/opportunities.json is never
 * touched.
 *
 * Reuses the existing fetchers unmodified as child processes (they only ever
 * write their own data/raw/*.json — see each script's header) with env knobs
 * for "everything open" / modestly-raised caps, then reuses the same
 * normalizers 2-normalize.mjs / assemble-mvp-corpus.mjs call
 * (scripts/lib/normalize*.mjs) to build the fresh record set:
 *   - drops any record whose deadline has already passed
 *   - reuses embeddings for unchanged records, embeds only new/changed ones
 *     (lib/corpus/refresh.ts's planEmbedding — full re-embed if the
 *     configured EMBEDDINGS_MODEL differs from the prior corpus's)
 *   - writes atomically (temp file + rename); never clobbers the existing
 *     local corpus on error
 * Single-flight via a lock file (lib/corpus/refreshStatus.ts) shared with
 * POST /api/corpus/refresh.
 */
import "./_loadEnvLocal.mjs"; // honor scaffold/.env.local when run as plain `node`
import { spawnSync } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { embedBatch } from "../lib/embed.ts";
import { dropExpiredOpportunities } from "../lib/corpus/expiry.ts";
import {
  countBySource,
  countRemoved,
  dedupeById,
  findUnhealthySources,
  opportunityEmbedText,
  planEmbedding,
} from "../lib/corpus/refresh.ts";
import { acquireRefreshLock, releaseRefreshLock, writeRefreshStatus } from "../lib/corpus/refreshStatus.ts";
import { normalizeGrantsRecord, normalizeSbirSolicitation } from "./lib/normalizeGrants.mjs";
import { normalizeSamRow, normalizeSbirAward, normalizeProcurementRecord } from "./lib/normalizeNewSources.mjs";

const LOCAL_DIR = "data/local";
const LOCAL_OPPS = join(LOCAL_DIR, "opportunities.json");
const LOCAL_META = join(LOCAL_DIR, "corpus-meta.json");
const EMBED_MODEL = process.env.EMBEDDINGS_MODEL || "text-embedding-3-small";
const EMBED_BATCH = 64;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Retries embedBatch with exponential backoff on 429/5xx, same policy as
 *  scripts/3-embed.mjs — a single transient rate limit or Ollama hiccup must
 *  not discard a run of up to ~30 minutes of prior embedding work. */
async function embedBatchWithRetry(texts, attempt = 0) {
  try {
    return await embedBatch(texts);
  } catch (e) {
    const status = Number(String(e.message).match(/\((\d+)\)/)?.[1]);
    if (!(status === 429 || status >= 500) || attempt >= 7) throw e;
    const wait = Math.min(60000, 1000 * 2 ** attempt);
    console.warn(`\n  embedding batch failed (${status}) — backing off ${Math.round(wait / 1000)}s (retry ${attempt + 1}/7)`);
    await sleep(wait);
    return embedBatchWithRetry(texts, attempt + 1);
  }
}

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return fallback;
  }
}

async function writeAtomic(path, content) {
  const tmp = `${path}.tmp-${process.pid}`;
  await writeFile(tmp, content);
  await rename(tmp, path);
}

function run(label, script, env) {
  console.log(`\n— ${label} —`);
  const res = spawnSync(process.execPath, [script], {
    stdio: "inherit",
    windowsHide: true,
    env: { ...process.env, ...env },
  });
  if (res.status !== 0) throw new Error(`${script} exited ${res.status}`);
}

async function main() {
  const t0 = Date.now();
  await mkdir(LOCAL_DIR, { recursive: true });
  // When POST /api/corpus/refresh spawns us, it already claimed the lock
  // (and transferred it to our pid) before spawning, to close the race a
  // second POST could otherwise slip through — don't re-claim it here.
  const lockHeld = process.env.GRANTED_REFRESH_LOCK_HELD === "1";
  if (!lockHeld && !acquireRefreshLock()) {
    console.log("data:refresh — another refresh is already running (lock held). Exiting.");
    process.exitCode = 1;
    return;
  }

  try {
    await mkdir("data/raw", { recursive: true });
    run("grants.gov (everything open)", "scripts/1-fetch.mjs", { GRANTS_FETCH_MODE: "all" });
    run("SAM.gov assistance (everything open)", "scripts/1-fetch-sam-assistance.mjs", { SAM_FETCH_MODE: "all" });
    run("SBIR/STTR", "scripts/1-fetch-sbir-corpus.mjs", { SBIR_CAP_TOTAL: "260", SBIR_CAP_PER_AGENCY: "60" });
    run("Procurement", "scripts/1-fetch-procurement.mjs", { PROCUREMENT_PER_QUERY: "24", PROCUREMENT_UTAH_LIMIT: "40" });

    const [grants, sbirSolicitations, samAssistance, sbirAwards, procurement] = await Promise.all([
      readJson("data/raw/grants.json", []),
      readJson("data/raw/sbir-solicitations.json", []),
      readJson("data/raw/sam-assistance.json", []),
      readJson("data/raw/sbir-corpus.json", []),
      readJson("data/raw/usaspending-contracts.json", []),
    ]);

    let fresh = [
      ...grants.map(normalizeGrantsRecord),
      ...sbirSolicitations.map(normalizeSbirSolicitation),
      ...samAssistance.map(normalizeSamRow),
      ...sbirAwards.map(normalizeSbirAward),
      ...procurement.map(normalizeProcurementRecord),
    ].filter((o) => o && o.description && o.description.length >= 60);
    fresh = dedupeById(fresh);
    fresh = dropExpiredOpportunities(fresh);
    console.log(`\nAssembled ${fresh.length} open records (expired deadlines dropped).`);

    const existing = await readJson(LOCAL_OPPS, await readJson("data/opportunities.json", []));
    const existingMeta = await readJson(LOCAL_META, await readJson("data/corpus-meta.json", {}));

    const unhealthy = findUnhealthySources(countBySource(existing), countBySource(fresh));
    if (unhealthy.length) {
      throw new Error(`refresh aborted — source count dropped sharply: ${unhealthy.join("; ")}`);
    }
    const priorById = new Map();
    for (const o of existing) {
      if (Array.isArray(o.embedding) && o.embedding.length > 0) {
        priorById.set(o.id, { embedding: o.embedding, text: opportunityEmbedText(o) });
      }
    }

    const plan = planEmbedding(fresh, priorById, existingMeta.embeddingModel, EMBED_MODEL);
    console.log(
      `Embedding plan: ${plan.reused.length} reused, ${plan.toEmbed.length} to embed with ${EMBED_MODEL}` +
        (plan.fullReembed ? " (embedding model changed — full re-embed)" : ""),
    );

    const embedded = [];
    for (let i = 0; i < plan.toEmbed.length; i += EMBED_BATCH) {
      const slice = plan.toEmbed.slice(i, i + EMBED_BATCH);
      const vectors = await embedBatchWithRetry(slice.map((o) => opportunityEmbedText(o)));
      slice.forEach((o, k) => embedded.push({ ...o, embedding: vectors[k].map((v) => Math.round(v * 1e5) / 1e5) }));
      process.stdout.write(`\rembedded ${Math.min(i + EMBED_BATCH, plan.toEmbed.length)}/${plan.toEmbed.length}`);
    }
    if (plan.toEmbed.length) process.stdout.write("\n");

    const final = [...plan.reused, ...embedded];
    const removed = countRemoved(existing.map((o) => o.id), new Set(final.map((o) => o.id)));
    const dims = final.find((o) => Array.isArray(o.embedding) && o.embedding.length > 0)?.embedding?.length;

    const meta = {
      builtAt: new Date().toISOString(),
      note: "Local corpus refresh (npm run data:refresh) — gitignored, never committed. Read by lib/corpus/store.ts.",
      count: final.length,
      embeddingModel: EMBED_MODEL,
      dims: dims ?? existingMeta.dims,
    };

    await writeAtomic(LOCAL_OPPS, JSON.stringify(final));
    await writeAtomic(LOCAL_META, JSON.stringify(meta, null, 2));

    const durationS = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(
      `\n→ corpus refreshed: ${final.length} total ` +
        `(+${plan.added} added, ~${plan.updated} updated, -${removed} removed) in ${durationS}s`,
    );
    writeRefreshStatus({});
  } catch (e) {
    console.error(`\ndata:refresh FAILED — ${e.message}`);
    writeRefreshStatus({ lastError: e.message });
    process.exitCode = 1;
  } finally {
    releaseRefreshLock();
  }
}

await main();
