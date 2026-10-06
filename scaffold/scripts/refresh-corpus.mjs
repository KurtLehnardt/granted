/**
 * npm run data:refresh: fetch every open listing into data/local/ (gitignored; data/raw and the
 * committed corpus are untouched), drop expired, cap, embed only new/changed records, write atomically.
 *
 * Records are embedded in the embedding space search uses (lib/embeddings/spaces.ts), so a refresh
 * needs no API key when search is built-in: new and changed records are embedded in this process
 * and written to data/local/vectors/, reusing every vector whose id and text are unchanged. With
 * OpenAI (or a custom embedder) the inline vectors are refreshed as before, and the built-in vectors
 * are kept up to date as well whenever the built-in model is downloaded.
 */
import "./_loadEnvLocal.mjs"; // honor scaffold/.env.local when run as plain `node`
import { spawnSync } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { embedBatch, EMBEDDINGS_DIMENSIONS, EMBEDDINGS_MODEL } from "../lib/embed.ts";
import { activeSearchSpace, getSpace } from "../lib/embeddings/spaces.ts";
import { embedWithBuiltin, ensureBuiltinModel, isBuiltinModelPresent } from "../lib/embeddings/builtin.ts";
import { buildSpaceVectors } from "./lib/spaceVectors.mjs";
import { readVectorFile, writeVectorFile } from "./lib/vectorFile.mjs";
import { BUILTIN_MODEL } from "./lib/builtinModel.mjs";
import { clampCorpusSize, DEFAULT_CORPUS_SIZE } from "../lib/searchSettings.ts";
import { dropExpiredOpportunities } from "../lib/corpus/expiry.ts";
import { dropPastAwards } from "../lib/corpus/pastAwards.ts";
import { selectCorpusWithinCap } from "../lib/corpus/selection.ts";
import {
  computeStopOutcome,
  countBySource,
  countRemoved,
  dedupeById,
  findUnhealthySources,
  opportunityEmbedText,
  planEmbedding,
} from "../lib/corpus/refresh.ts";
import {
  acquireRefreshLock,
  clearStopRequest,
  isStopRequested,
  releaseRefreshLock,
  writeRefreshStatus,
  writeRefreshProgress,
} from "../lib/corpus/refreshStatus.ts";
import { overallPct } from "../lib/corpus/refreshProgress.ts";
import { normalizeGrantsRecord, normalizeSbirSolicitation } from "./lib/normalizeGrants.mjs";
import { normalizeSamRow, normalizeCaRow, normalizeIlRow, normalizeNcRow } from "./lib/normalizeNewSources.mjs";

const LOCAL_DIR = "data/local";
const RAW_DIR = join(LOCAL_DIR, "raw");
const LOCAL_OPPS = join(LOCAL_DIR, "opportunities.json");
const LOCAL_META = join(LOCAL_DIR, "corpus-meta.json");
const LOCAL_VECTORS = join(LOCAL_DIR, "vectors");
const COMMITTED_VECTORS = join("data", "vectors");

// The space search uses decides what this refresh must embed. Inline spaces (OpenAI, a custom
// embedder) keep their vectors in opportunities.json; the built-in space has its own vector file.
const SEARCH_SPACE = activeSearchSpace().space;
const INLINE_SPACE = SEARCH_SPACE.vectors.kind === "inline" ? SEARCH_SPACE : null;
const INLINE_MODEL = INLINE_SPACE?.id === "openai" ? INLINE_SPACE.model : EMBEDDINGS_MODEL;
const INLINE_DIMS = INLINE_SPACE?.id === "openai" ? INLINE_SPACE.dims : EMBEDDINGS_DIMENSIONS;
const BUILTIN_SPACE = getSpace("builtin");
const EMBED_BATCH = 64;
const STOP_EXIT_CODE = 75; // 1-fetch.mjs uses this to signal "stopped, not failed" between detail-fetch batches
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function reportProgress(stage, { done, total, foundCount, keptCount } = {}) {
  writeRefreshProgress({
    stage,
    ...(done != null ? { done } : {}),
    ...(total != null ? { total } : {}),
    pct: overallPct(stage, done, total),
    ...(foundCount != null ? { foundCount } : {}),
    ...(keptCount != null ? { keptCount } : {}),
  });
}

const maxFlag = process.argv.indexOf("--max");
const requestedMax = Number(maxFlag !== -1 ? process.argv[maxFlag + 1] : process.env.CORPUS_MAX);
const MAX_CORPUS_SIZE = Number.isFinite(requestedMax) ? clampCorpusSize(requestedMax) : DEFAULT_CORPUS_SIZE;

/** `{ escalate: true }` when the first batch's real dims differ from priorDims (EMBEDDINGS_DIMENSIONS is unset off OpenAI). */
async function embedAll(toEmbedList, { foundCount, keptCount, allowReembedEscalation, priorDims }) {
  const embedded = [];
  for (let i = 0; i < toEmbedList.length; i += EMBED_BATCH) {
    if (isStopRequested()) return { embedded, stopped: true };
    const slice = toEmbedList.slice(i, i + EMBED_BATCH);
    const vectors = await embedBatchWithRetry(slice.map((o) => opportunityEmbedText(o)));
    if (allowReembedEscalation && i === 0 && priorDims != null && vectors[0] && vectors[0].length !== priorDims) {
      return { escalate: true };
    }
    slice.forEach((o, k) => embedded.push({ ...o, embedding: vectors[k].map((v) => Math.round(v * 1e5) / 1e5) }));
    process.stdout.write(`\rembedded ${Math.min(i + EMBED_BATCH, toEmbedList.length)}/${toEmbedList.length}`);
    reportProgress("embedding", { done: embedded.length, total: toEmbedList.length, foundCount, keptCount });
  }
  return { embedded, stopped: false };
}

async function embedBatchWithRetry(texts, attempt = 0) {
  try {
    return await embedBatch(texts, undefined, undefined, { space: INLINE_SPACE, kind: "document" });
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

function run(label, script, env, { tsx = false } = {}) {
  console.log(`\n— ${label} —`);
  const args = tsx ? ["--import", "tsx", script] : [script];
  const res = spawnSync(process.execPath, args, {
    stdio: "inherit",
    windowsHide: true,
    env: { ...process.env, GRANTED_REFRESH_RUN: "1", ...env },
  });
  if (res.status === STOP_EXIT_CODE) return { stopped: true };
  if (res.status !== 0) throw new Error(`${script} exited ${res.status}`);
  return { stopped: false };
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
  // Only clear when we took the lock ourselves; the API already cleared it for a spawned run.
  if (!lockHeld) clearStopRequest();

  let existingMeta = {};
  let existingById = new Map();

  async function applyStop(opts) {
    const realDims = opts.embeddedSoFar?.[0]?.embedding?.length;
    const outcome = computeStopOutcome({
      stoppedAt: new Date().toISOString(),
      duringEmbedding: false,
      fullReembed: false,
      reused: [],
      embeddedSoFar: [],
      notYetEmbedded: [],
      priorById: existingById,
      dims: realDims ?? INLINE_DIMS ?? existingMeta.dims,
      ...opts,
    });
    if (outcome.save) {
      const dims = outcome.corpus.find((o) => Array.isArray(o.embedding) && o.embedding.length > 0)?.embedding?.length;
      const meta = {
        builtAt: new Date().toISOString(),
        note: "Local corpus refresh (npm run data:refresh) — gitignored, never committed. Read by lib/corpus/store.ts.",
        count: outcome.corpus.length,
        embeddingModel: INLINE_SPACE ? INLINE_MODEL : existingMeta.embeddingModel,
        dims: dims ?? existingMeta.dims,
      };
      await writeAtomic(LOCAL_OPPS, JSON.stringify(outcome.corpus));
      await writeAtomic(LOCAL_META, JSON.stringify(meta, null, 2));
      console.log(`\ndata:refresh stopped by user during embedding — saved ${outcome.corpus.length} records.`);
    } else if (opts.duringEmbedding && opts.fullReembed) {
      console.log(
        "\ndata:refresh stopped by user during a full re-embed — corpus left unchanged " +
          "to avoid mixing embedding models or dimensionalities.",
      );
    } else {
      console.log("\ndata:refresh stopped by user — corpus unchanged.");
    }
    writeRefreshStatus(outcome.status);
  }

  try {
    await mkdir(RAW_DIR, { recursive: true });
    const rawEnv = { RAW_DIR };
    reportProgress("grants.gov search");
    const grantsRun = run(
      "grants.gov (everything open)",
      "scripts/1-fetch.mjs",
      { ...rawEnv, GRANTS_FETCH_MODE: "all", GRANTS_ONLY: "1" },
      { tsx: true },
    );
    if (grantsRun.stopped) return await applyStop({});

    const grantsFound = new Set((await readJson(join(RAW_DIR, "grants.json"), [])).map((g) => g.id)).size;

    reportProgress("sam.gov", { foundCount: grantsFound });
    if (isStopRequested()) return await applyStop({});
    run("SAM.gov assistance (everything open)", "scripts/1-fetch-sam-assistance.mjs", { ...rawEnv, SAM_FETCH_MODE: "all" });

    if (isStopRequested()) return await applyStop({});
    run("California Grants Portal", "scripts/1-fetch-ca-grants.mjs", rawEnv);
    run("Illinois CSFA", "scripts/1-fetch-il-grants.mjs", rawEnv);
    run("North Carolina grant directory", "scripts/1-fetch-nc-grants.mjs", rawEnv);

    if (isStopRequested()) return await applyStop({});

    const [grants, sbirSolicitations, samAssistance, caGrants, ilGrants, ncGrants] = await Promise.all([
      readJson(join(RAW_DIR, "grants.json"), []),
      readJson(join(RAW_DIR, "sbir-solicitations.json"), []),
      readJson(join(RAW_DIR, "sam-assistance.json"), []),
      readJson(join(RAW_DIR, "ca-grants.json"), []),
      readJson(join(RAW_DIR, "il-grants.json"), []),
      readJson(join(RAW_DIR, "nc-grants.json"), []),
    ]);

    const existing = await readJson(LOCAL_OPPS, await readJson("data/opportunities.json", []));
    existingMeta = await readJson(LOCAL_META, await readJson("data/corpus-meta.json", {}));
    existingById = new Map(existing.map((o) => [o.id, o]));

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
      ...caGrants.map(normalizeCaRow),
      ...ilGrants.map(normalizeIlRow),
      ...ncGrants.map(normalizeNcRow),
    ].filter((o) => o && o.description && o.description.length >= 60);
    fresh = dedupeById(fresh);
    // Carry a record's first-ever retrieval timestamp forward across refreshes
    // (a real "recently added" signal over time), source-agnostic -- stamps
    // every genuinely-new record (including every CA/IL/NC row on their first
    // run) with this run's timestamp.
    const attemptAt = new Date().toISOString();
    fresh = fresh.map((o) => ({ ...o, retrieved_at: existingById.get(o.id)?.retrieved_at ?? o.retrieved_at ?? attemptAt }));
    fresh = dropExpiredOpportunities(fresh);
    const foundCount = fresh.length;
    console.log(`\nAssembled ${foundCount} open records (expired deadlines dropped).`);
    reportProgress("selecting", { foundCount });

    // Legacy past awards in `existing` aren't a source outage.
    const unhealthy = findUnhealthySources(countBySource(dropPastAwards(existing)), countBySource(fresh));
    if (unhealthy.length) {
      throw new Error(`refresh aborted — source count dropped sharply: ${unhealthy.join("; ")}`);
    }

    if (isStopRequested()) return await applyStop({});

    fresh = selectCorpusWithinCap(fresh, MAX_CORPUS_SIZE);
    const keptCount = fresh.length;
    console.log(`Capped to ${keptCount} of the assembled set (max ${MAX_CORPUS_SIZE}).`);
    reportProgress("selecting", { done: 1, total: 1, foundCount, keptCount });

    if (isStopRequested()) return await applyStop({});

    const priorById = new Map();
    for (const o of existing) {
      if (Array.isArray(o.embedding) && o.embedding.length > 0) {
        priorById.set(o.id, { embedding: o.embedding, text: opportunityEmbedText(o) });
      }
    }
    // Older corpora (incl. the committed snapshot) predate meta.dims.
    const priorDims = existingMeta.dims ?? priorById.values().next().value?.embedding?.length;

    // With search on the built-in model, inline vectors are only carried over for unchanged
    // records (so switching back to OpenAI later still finds most of them); nothing is sent to
    // an HTTP embedder, so no key is needed.
    let plan = planEmbedding(
      fresh,
      priorById,
      existingMeta.embeddingModel,
      INLINE_SPACE ? INLINE_MODEL : (existingMeta.embeddingModel ?? INLINE_MODEL),
      INLINE_SPACE ? (INLINE_DIMS ?? priorDims) : priorDims,
      priorDims,
    );
    if (INLINE_SPACE) {
      console.log(
        `Embedding plan: ${plan.reused.length} reused, ${plan.toEmbed.length} to embed with ${INLINE_MODEL}` +
          (plan.fullReembed ? " (embedding model or dimensions changed — full re-embed)" : ""),
      );
    }

    // Built-in vectors: required when search uses them, kept fresh otherwise if the model is here.
    const builtinVectors = await refreshBuiltinVectors(fresh, { foundCount, keptCount, required: !INLINE_SPACE });
    if (builtinVectors?.stopped) {
      reportProgress("saving", { foundCount, keptCount });
      const kept = plan.reused.concat(plan.toEmbed.map(withoutEmbedding));
      await writeAtomic(LOCAL_OPPS, JSON.stringify(kept));
      await writeAtomic(LOCAL_META, JSON.stringify(localMeta(kept, existingMeta), null, 2));
      console.log(
        `\ndata:refresh stopped by user during embedding — saved ${kept.length} records (${builtinVectors.entries.length} with search vectors).`,
      );
      writeRefreshStatus({ lastStoppedAt: new Date().toISOString(), stopped: true, savedCount: kept.length });
      return;
    }

    if (!INLINE_SPACE) {
      plan = { ...plan, toEmbed: [], reused: plan.reused.concat(plan.toEmbed.map(withoutEmbedding)) };
    }
    reportProgress("embedding", { done: 0, total: plan.toEmbed.length, foundCount, keptCount });

    let result = await embedAll(plan.toEmbed, {
      foundCount,
      keptCount,
      allowReembedEscalation: !plan.fullReembed,
      priorDims,
    });
    if (result.escalate) {
      console.warn(
        "\n  embedder's actual output dims differ from the corpus's recorded dims — forcing a full " +
          "re-embed so the corpus never mixes dimensions.",
      );
      plan = planEmbedding(fresh, priorById, existingMeta.embeddingModel, INLINE_MODEL, INLINE_DIMS ?? priorDims, priorDims, true);
      reportProgress("embedding", { done: 0, total: plan.toEmbed.length, foundCount, keptCount });
      result = await embedAll(plan.toEmbed, { foundCount, keptCount, allowReembedEscalation: false });
    }
    if (plan.toEmbed.length) process.stdout.write("\n");
    const embedded = result.embedded;
    const stoppedDuringEmbedding = result.stopped;

    if (stoppedDuringEmbedding) {
      const notYetEmbedded = plan.toEmbed.slice(embedded.length);
      reportProgress("saving", { foundCount, keptCount });
      return await applyStop({
        duringEmbedding: true,
        fullReembed: plan.fullReembed,
        reused: plan.reused,
        embeddedSoFar: embedded,
        notYetEmbedded,
        priorById: existingById,
      });
    }

    reportProgress("saving", { foundCount, keptCount });

    const final = [...plan.reused, ...embedded];
    const removed = countRemoved(existing.map((o) => o.id), new Set(final.map((o) => o.id)));
    const dims = final.find((o) => Array.isArray(o.embedding) && o.embedding.length > 0)?.embedding?.length;

    const meta = { ...localMeta(final, existingMeta), dims: dims ?? existingMeta.dims };

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
    clearStopRequest();
  }
}

function withoutEmbedding(o) {
  const { embedding: _drop, ...rest } = o;
  return rest;
}

function localMeta(records, existingMeta) {
  return {
    builtAt: new Date().toISOString(),
    note: "Local corpus refresh (npm run data:refresh) — gitignored, never committed. Read by lib/corpus/store.ts.",
    count: records.length,
    embeddingModel: INLINE_SPACE ? INLINE_MODEL : existingMeta.embeddingModel,
    dims: records.find((o) => Array.isArray(o.embedding) && o.embedding.length > 0)?.embedding?.length ?? existingMeta.dims,
  };
}

/**
 * Bring data/local/vectors/ (the built-in space) up to date for `records`, embedding only
 * new or changed ones in this process. `required`: search uses these vectors, so the model is
 * downloaded if missing and a failure fails the refresh. Otherwise it only runs when the model
 * is already downloaded, and a failure is just a warning (search doesn't use them right now).
 */
async function refreshBuiltinVectors(records, { foundCount, keptCount, required }) {
  if (!required && !isBuiltinModelPresent()) return null;
  try {
    if (required) await ensureBuiltinModel((pct) => process.stdout.write(`\rdownloading the search model: ${pct}%`));
    const name = BUILTIN_SPACE.vectors.name;
    // The committed vectors cover the shipped corpus; a previous refresh's cover what it added.
    const prior = new Map([
      ...(readVectorFile(COMMITTED_VECTORS, name)?.vectors ?? new Map()),
      ...(readVectorFile(LOCAL_VECTORS, name)?.vectors ?? new Map()),
    ]);
    const result = await buildSpaceVectors(BUILTIN_SPACE, records, {
      prior,
      embed: (texts) => embedWithBuiltin(texts),
      batch: 16,
      shouldStop: isStopRequested,
      onProgress: (done, total) => {
        process.stdout.write(`\rsearch vectors: embedded ${done}/${total}`);
        reportProgress("embedding", { done, total, foundCount, keptCount });
      },
    });
    writeVectorFile(
      LOCAL_VECTORS,
      name,
      { space: BUILTIN_SPACE.id, model: BUILTIN_SPACE.model, revision: BUILTIN_MODEL.revision, dims: BUILTIN_SPACE.dims },
      result.entries,
    );
    console.log(`\nBuilt-in search vectors: ${result.reused} reused, ${result.embedded} embedded.`);
    return result;
  } catch (e) {
    if (required) throw e;
    console.warn(`\n(couldn't update the built-in search vectors: ${e.message}; search isn't using them right now)`);
    return null;
  }
}

await main();
