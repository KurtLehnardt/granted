/**
 * npm run data:refresh: fetch every open listing into data/local/ (gitignored; data/raw and the
 * committed corpus are untouched), drop expired, cap, embed only new/changed records, write atomically.
 */
import "./_loadEnvLocal.mjs"; // honor scaffold/.env.local when run as plain `node`
import { spawnSync } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { embedBatch, EMBEDDINGS_DIMENSIONS, EMBEDDINGS_MODEL } from "../lib/embed.ts";
import { clampCorpusSize, DEFAULT_CORPUS_SIZE } from "../lib/searchSettings.ts";
import { dropExpiredOpportunities } from "../lib/corpus/expiry.ts";
import { selectCorpusWithinCap } from "../lib/corpus/selection.ts";
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
const RAW_DIR = join(LOCAL_DIR, "raw");
const LOCAL_OPPS = join(LOCAL_DIR, "opportunities.json");
const LOCAL_META = join(LOCAL_DIR, "corpus-meta.json");
const EMBED_BATCH = 64;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const maxFlag = process.argv.indexOf("--max");
const requestedMax = Number(maxFlag !== -1 ? process.argv[maxFlag + 1] : process.env.CORPUS_MAX);
const MAX_CORPUS_SIZE = Number.isFinite(requestedMax) ? clampCorpusSize(requestedMax) : DEFAULT_CORPUS_SIZE;

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
  const attemptAt = new Date(t0).toISOString();
  await mkdir(LOCAL_DIR, { recursive: true });
  const lockHeld = process.env.GRANTED_REFRESH_LOCK_HELD === "1";
  if (!lockHeld && !acquireRefreshLock()) {
    console.log("data:refresh — another refresh is already running (lock held). Exiting.");
    process.exitCode = 1;
    return;
  }

  try {
    await mkdir(RAW_DIR, { recursive: true });
    const rawEnv = { RAW_DIR };
    run("grants.gov (everything open)", "scripts/1-fetch.mjs", { ...rawEnv, GRANTS_FETCH_MODE: "all", GRANTS_ONLY: "1" });
    run("SAM.gov assistance (everything open)", "scripts/1-fetch-sam-assistance.mjs", { ...rawEnv, SAM_FETCH_MODE: "all" });
    run("SBIR/STTR", "scripts/1-fetch-sbir-corpus.mjs", { ...rawEnv, SBIR_CAP_TOTAL: "260", SBIR_CAP_PER_AGENCY: "60" });
    run("Procurement", "scripts/1-fetch-procurement.mjs", { ...rawEnv, PROCUREMENT_PER_QUERY: "24", PROCUREMENT_UTAH_LIMIT: "40" });

    const [grants, sbirSolicitations, samAssistance, sbirAwards, procurement] = await Promise.all([
      readJson(join(RAW_DIR, "grants.json"), []),
      readJson(join(RAW_DIR, "sbir-solicitations.json"), []),
      readJson(join(RAW_DIR, "sam-assistance.json"), []),
      readJson(join(RAW_DIR, "sbir-corpus.json"), []),
      readJson(join(RAW_DIR, "usaspending-contracts.json"), []),
    ]);

    const existing = await readJson(LOCAL_OPPS, await readJson("data/opportunities.json", []));
    const existingMeta = await readJson(LOCAL_META, await readJson("data/corpus-meta.json", {}));
    const existingById = new Map(existing.map((o) => [o.id, o]));

    // A failed detail fetch normalizes to a title-only record; keep the prior full one, with current dates.
    const normalizedGrants = grants.map((g) => {
      const norm = normalizeGrantsRecord(g);
      const prior = !g._detail && existingById.get(norm.id);
      return prior ? { ...prior, deadline: norm.deadline, forecasted: norm.forecasted } : norm;
    });

    let fresh = [
      ...normalizedGrants,
      ...sbirSolicitations.map(normalizeSbirSolicitation),
      ...samAssistance.map(normalizeSamRow),
      ...sbirAwards.map(normalizeSbirAward),
      ...procurement.map(normalizeProcurementRecord),
    ].filter((o) => o && o.description && o.description.length >= 60);
    fresh = dedupeById(fresh);
    fresh = dropExpiredOpportunities(fresh);
    console.log(`\nAssembled ${fresh.length} open records (expired deadlines dropped).`);

    const unhealthy = findUnhealthySources(countBySource(existing), countBySource(fresh));
    if (unhealthy.length) {
      throw new Error(`refresh aborted — source count dropped sharply: ${unhealthy.join("; ")}`);
    }

    fresh = selectCorpusWithinCap(fresh, MAX_CORPUS_SIZE);
    console.log(`Capped to ${fresh.length} of the assembled set (max ${MAX_CORPUS_SIZE}).`);

    const priorById = new Map();
    for (const o of existing) {
      if (Array.isArray(o.embedding) && o.embedding.length > 0) {
        priorById.set(o.id, { embedding: o.embedding, text: opportunityEmbedText(o) });
      }
    }

    const plan = planEmbedding(fresh, priorById, existingMeta.embeddingModel, EMBEDDINGS_MODEL, EMBEDDINGS_DIMENSIONS ?? existingMeta.dims);
    console.log(
      `Embedding plan: ${plan.reused.length} reused, ${plan.toEmbed.length} to embed with ${EMBEDDINGS_MODEL}` +
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
      embeddingModel: EMBEDDINGS_MODEL,
      dims: dims ?? existingMeta.dims,
    };

    await writeAtomic(LOCAL_OPPS, JSON.stringify(final));
    await writeAtomic(LOCAL_META, JSON.stringify(meta, null, 2));

    const durationS = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(
      `\n→ corpus refreshed: ${final.length} total ` +
        `(+${plan.added} added, ~${plan.updated} updated, -${removed} removed) in ${durationS}s`,
    );
    writeRefreshStatus({ lastCompletedAt: attemptAt });
  } catch (e) {
    console.error(`\ndata:refresh FAILED — ${e.message}`);
    writeRefreshStatus({ lastAttemptAt: attemptAt, lastError: e.message });
    process.exitCode = 1;
  } finally {
    releaseRefreshLock();
  }
}

await main();
