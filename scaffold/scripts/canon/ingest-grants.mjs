// ============================================================================
// CAN-02 — scheduled grants.gov ingestion into the Supabase Canon store.
// ----------------------------------------------------------------------------
// Adapts the working v1 fetch+normalize logic (scripts/1-fetch.mjs +
// scripts/2-normalize.mjs — search2 + fetchOpportunity, HTML stripping) into a
// script that can run unattended on a schedule (.github/workflows/canon-sync.yml):
// fetch -> normalize (lib/canon/normalize.ts) -> embed (OpenAI, 512-dim,
// same model as retrieval) -> validate at the write boundary
// (CanonOpportunitySchema) -> upsert into Supabase under a NEW snapshot_version.
//
// COVERAGE: broadened beyond v1's ~15 demo keywords via scripts/canon/keywords.mjs
// (documented in scaffold/docs/canon.md). Configurable via --keywords/--categories
// for a smoke-test slice; defaults to the full list for the scheduled run.
//
// IDEMPOTENT: upsertOpportunity (lib/canon/store.ts) is `on conflict (id) do
// update`, keyed on the stable `grants-<id>` row id — re-running the same (or
// a later) day never duplicates rows, it refreshes them.
//
// DEGRADE, DON'T FAIL SILENTLY (§4.4 / §4.6, CAN-02 DoD): each keyword search
// and each detail fetch is independently try/caught — one bad call narrows
// coverage, it does not abort the run. Failures are collected as `alarms` and
// surfaced as GitHub Actions `::warning::`/`::error::` annotations AND written
// into the snapshot's `source_coverage`, so a degraded run is loud and
// auditable, never a quietly-stale corpus. `runSource` wraps each source's
// entire pipeline the same way, so CAN-03 can add SBIR/SAM.gov/USAspending as
// additional `runSource(...)` calls without changing this failure pattern.
//
// Run (from scaffold/), secrets already in env (never printed):
//   node --import tsx scripts/canon/ingest-grants.mjs                # full run
//   node --import tsx scripts/canon/ingest-grants.mjs --keywords="artificial intelligence,quantum computing"
//   node --import tsx scripts/canon/ingest-grants.mjs --categories=ai_data,health
//   node --import tsx scripts/canon/ingest-grants.mjs --max-keywords=3
//   npm run canon:ingest -- --max-keywords=3
// ============================================================================

import { CanonOpportunitySchema } from "../../lib/canon/CanonOpportunity.ts";
import { normalizeGrantsGovRecord } from "../../lib/canon/normalize.ts";
import {
  upsertOpportunities,
  upsertSnapshot,
  countOpportunities,
  closeStore,
} from "../../lib/canon/store.ts";
import { ALL_KEYWORDS, keywordsForCategories } from "./keywords.mjs";

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = {};
  for (const raw of argv) {
    const m = raw.match(/^--([^=]+)(?:=(.*))?$/s);
    if (!m) continue;
    args[m[1]] = m[2] ?? true;
  }
  return args;
}

const argv = parseArgs(process.argv.slice(2));

function defaultSnapshotVersion() {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `canon-sync-${y}${m}${day}`;
}

let KEYWORDS;
if (typeof argv.keywords === "string") {
  KEYWORDS = argv.keywords.split(",").map((s) => s.trim()).filter(Boolean);
} else if (typeof argv.categories === "string") {
  KEYWORDS = keywordsForCategories(argv.categories.split(",").map((s) => s.trim()).filter(Boolean));
} else {
  KEYWORDS = ALL_KEYWORDS;
}
if (argv["max-keywords"]) {
  KEYWORDS = KEYWORDS.slice(0, Number(argv["max-keywords"]));
}

const SNAPSHOT_VERSION = typeof argv.snapshot === "string" ? argv.snapshot : defaultSnapshotVersion();

const OPENAI_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_KEY) {
  console.error("OPENAI_API_KEY is not set. Add it to .env.local (or your environment).");
  process.exit(1);
}
// FUNDFINDER_DB_PASSWORD is validated lazily by lib/canon/store.ts's getSql().

// ---------------------------------------------------------------------------
// Alarms — printed as GitHub Actions annotations (visible in the Actions UI
// even before CAN-06 wires real alerting) AND persisted into the snapshot row
// so a degraded run is auditable from the DB alone, not just CI logs.
// ---------------------------------------------------------------------------

const alarms = [];
function alarm(msg) {
  alarms.push(msg);
  console.warn(`::warning::canon-sync: ${msg}`);
}
function fatalAlarm(msg) {
  alarms.push(msg);
  console.error(`::error::canon-sync: ${msg}`);
}

/** Wrap one source's entire ingestion pipeline. A thrown error degrades that
 * source (alarmed) instead of crashing the process — the shape CAN-03 reuses
 * for SBIR/SAM.gov/USAspending. */
async function runSource(name, fn) {
  try {
    return await fn();
  } catch (e) {
    alarm(`source "${name}" failed entirely: ${e?.message ?? e}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) || 1 }, worker));
  return results;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Step 1 — grants.gov search2 per keyword. Each keyword call is independently
// try/caught: one failing keyword narrows coverage, it does not abort.
// ---------------------------------------------------------------------------

async function searchGrantsGov(keywords) {
  const hitsById = new Map(); // source id -> { hit, keywords: Set<string> }
  let keywordFailures = 0;

  for (const kw of keywords) {
    try {
      const res = await fetch("https://api.grants.gov/v1/api/search2", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rows: 100, keyword: kw, oppStatuses: "forecasted|posted" }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      const hits = json?.data?.oppHits ?? [];
      // search2 shape check — escalate (don't silently keep going) if the
      // response no longer looks like { data: { oppHits: [...] } } at all,
      // per the CAN-02 escalation clause ("grants.gov API shape changed").
      if (!Array.isArray(hits)) {
        throw new Error(`unexpected search2 response shape (no data.oppHits array): ${JSON.stringify(json).slice(0, 200)}`);
      }
      for (const h of hits) {
        const key = String(h.id);
        if (!hitsById.has(key)) hitsById.set(key, { hit: h, keywords: new Set() });
        hitsById.get(key).keywords.add(kw);
      }
      console.log(`grants.gov  ${kw.padEnd(32)} ${hits.length}`);
    } catch (e) {
      keywordFailures++;
      alarm(`grants.gov search2 failed for keyword "${kw}": ${e?.message ?? e}`);
    }
    await sleep(250); // gentle pacing — matches v1
  }

  if (keywords.length > 0 && keywordFailures === keywords.length) {
    throw new Error(`all ${keywords.length} grants.gov keyword searches failed — source appears down or its API shape changed`);
  }

  return { hitsById, keywordFailures };
}

// ---------------------------------------------------------------------------
// Step 2 — fetchOpportunity detail per unique id (bounded concurrency).
// A missing detail degrades that one record (shorter description, possibly
// filtered out downstream for being too thin) rather than the run.
// ---------------------------------------------------------------------------

async function fetchDetails(ids) {
  let detailFailures = 0;
  const pairs = await mapWithConcurrency(ids, 8, async (id) => {
    try {
      const res = await fetch("https://api.grants.gov/v1/api/fetchOpportunity", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ opportunityId: Number(id) }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      const detail = json?.data?.synopsis ?? json?.data?.forecast ?? null;
      return [id, detail];
    } catch (e) {
      detailFailures++;
      return [id, null];
    }
  });
  const detailById = new Map(pairs);

  const failureRate = ids.length ? detailFailures / ids.length : 0;
  if (detailFailures > 0) {
    console.log(`grants.gov  detail: ${ids.length - detailFailures}/${ids.length} succeeded (${detailFailures} failed)`);
  }
  // A handful of missing details is normal API flakiness; a majority failing
  // suggests the detail endpoint itself is down — alarm loudly on that.
  if (failureRate > 0.5) {
    alarm(`grants.gov fetchOpportunity failed for ${detailFailures}/${ids.length} ids (>50%) — detail endpoint may be degraded`);
  }

  return { detailById, detailFailures };
}

// ---------------------------------------------------------------------------
// Step 3 — embed descriptions with OpenAI (same model/dims as retrieval).
// Ported from scripts/3-embed.mjs. Embedding failures are NOT degraded —
// without a real embedding a row cannot be retrieved, so this escalates
// (throws) rather than writing embeddingless rows.
// ---------------------------------------------------------------------------

const EMBED_MODEL = "text-embedding-3-small";
const EMBED_DIMS = 512;
const EMBED_BATCH = 32;

async function embedBatch(inputs, attempt = 0) {
  const res = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${OPENAI_KEY}` },
    body: JSON.stringify({ model: EMBED_MODEL, dimensions: EMBED_DIMS, input: inputs }),
  });

  if (res.status === 429 || res.status >= 500) {
    if (attempt >= 7) throw new Error(`Gave up after ${attempt} retries (${res.status}): ${(await res.text()).slice(0, 300)}`);
    const ra = Number(res.headers.get("retry-after"));
    const wait = Number.isFinite(ra) && ra > 0 ? ra * 1000 : Math.min(60000, 1000 * 2 ** attempt);
    process.stdout.write(`\n  ${res.status} rate-limited — backing off ${Math.round(wait / 1000)}s (retry ${attempt + 1}/7)`);
    await sleep(wait);
    return embedBatch(inputs, attempt + 1);
  }
  if (!res.ok) {
    const body = await res.text();
    if (res.status === 401 || res.status === 403 || /insufficient_quota/i.test(body)) {
      throw new Error(`OpenAI embeddings rejected (${res.status}) — check credits/API key: ${body.slice(0, 300)}`);
    }
    throw new Error(`Embeddings failed (${res.status}): ${body.slice(0, 300)}`);
  }
  return (await res.json()).data;
}

async function embedAll(records) {
  let done = 0;
  for (let i = 0; i < records.length; i += EMBED_BATCH) {
    const slice = records.slice(i, i + EMBED_BATCH);
    const data = await embedBatch(slice.map((r) => `${r.title}. ${r.agency}. ${r.description}`.slice(0, 8000)));
    data.forEach((d, k) => {
      if (d.embedding.length !== EMBED_DIMS) {
        throw new Error(`embedding returned ${d.embedding.length} dims, expected ${EMBED_DIMS} — aborting to avoid truncation`);
      }
      slice[k].embedding = d.embedding.map((v) => Math.round(v * 1e5) / 1e5);
    });
    done += slice.length;
    process.stdout.write(`\rembedded ${done}/${records.length}`);
    await sleep(400); // gentle inter-batch pacing
  }
  if (records.length) process.stdout.write("\n");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function ingestGrantsGov() {
  const retrievedAt = new Date().toISOString();

  console.log(`grants.gov  ${KEYWORDS.length} keyword(s), snapshot "${SNAPSHOT_VERSION}"`);
  const { hitsById, keywordFailures } = await searchGrantsGov(KEYWORDS);

  const uniqueIds = [...hitsById.keys()];
  console.log(`grants.gov  ${uniqueIds.length} unique opportunities across ${KEYWORDS.length} keyword(s)`);
  const { detailById, detailFailures } = await fetchDetails(uniqueIds);

  const normalized = [];
  for (const id of uniqueIds) {
    const { hit, keywords } = hitsById.get(id);
    const detail = detailById.get(id) ?? null;
    const rec = normalizeGrantsGovRecord({
      hit,
      detail,
      keywords: [...keywords],
      retrievedAt,
      snapshotVersion: SNAPSHOT_VERSION,
    });
    normalized.push(rec);
  }

  // Quality gate (matches v1 2-normalize.mjs): drop anything with no usable
  // description before spending an embedding call on it.
  const withDescription = normalized.filter((o) => o.description && o.description.length >= 60);
  const droppedThin = normalized.length - withDescription.length;
  if (droppedThin > 0) {
    console.log(`grants.gov  dropped ${droppedThin} record(s) with too-thin descriptions (<60 chars)`);
  }

  return { records: withDescription, keywordFailures, detailFailures, droppedThin, totalHits: uniqueIds.length };
}

async function main() {
  const result = await runSource("grants.gov", ingestGrantsGov);
  const records = result?.records ?? [];

  if (records.length > 0) {
    console.log(`Embedding ${records.length} record(s) with ${EMBED_MODEL} (dims=${EMBED_DIMS})...`);
    await embedAll(records);
  }

  // Validate at the write boundary (CAN-02 brief) — a malformed record is
  // dropped + alarmed, not allowed to reach the store or abort the batch.
  const validated = [];
  let validationFailures = 0;
  for (const rec of records) {
    try {
      const canon = CanonOpportunitySchema.parse(rec);
      validated.push({ ...canon, raw: rec.raw });
    } catch (e) {
      validationFailures++;
      alarm(`schema validation failed for ${rec.id ?? "(unknown id)"}: ${e?.message ?? e}`);
    }
  }

  const sourceCoverage = {
    "grants.gov": {
      keywords_searched: KEYWORDS.length,
      keyword_failures: result?.keywordFailures ?? KEYWORDS.length,
      unique_opportunities_found: result?.totalHits ?? 0,
      detail_fetch_failures: result?.detailFailures ?? 0,
      dropped_thin_description: result?.droppedThin ?? 0,
      validation_failures: validationFailures,
      opportunities_written: validated.length,
    },
    embedding_dims: EMBED_DIMS,
    embedding_model: EMBED_MODEL,
    alarms,
    gaps: [
      "no SAM.gov contracts (CAN-03)",
      "no SBIR/STTR topics (CAN-03)",
      "no USAspending award history (CAN-03)",
      "eligibility_rules not yet extracted (CAN-04)",
      "no live per-result freshness check (CAN-05)",
    ],
    notes: `Scheduled grants.gov ingestion — ${KEYWORDS.length} keyword(s) (see scripts/canon/keywords.mjs).`,
  };

  await upsertSnapshot({
    version: SNAPSHOT_VERSION,
    sourceCoverage,
    notes: alarms.length > 0
      ? `Degraded run: ${alarms.length} alarm(s) — see source_coverage.alarms.`
      : "Clean run — no alarms.",
  });

  let written = 0;
  if (validated.length > 0) {
    written = await upsertOpportunities(validated, { concurrency: 16 });
  }
  const snapshotTotal = await countOpportunities(SNAPSHOT_VERSION);

  console.log("");
  console.log(`Snapshot "${SNAPSHOT_VERSION}": upserted ${written} row(s) this run; ${snapshotTotal} opportunities now carry this snapshot version.`);
  if (alarms.length > 0) {
    console.log(`DEGRADED run — ${alarms.length} alarm(s):`);
    for (const a of alarms) console.log(`  - ${a}`);
  } else {
    console.log("Clean run — no alarms.");
  }

  await closeStore();

  if (written === 0) {
    fatalAlarm(`canon-sync wrote 0 opportunities this run (snapshot "${SNAPSHOT_VERSION}" recorded the failure) — grants.gov ingestion produced nothing usable.`);
    process.exitCode = 1;
  }
}

main().catch(async (err) => {
  fatalAlarm(`canon-sync crashed: ${err?.message ?? err}`);
  await closeStore().catch(() => {});
  process.exitCode = 1;
});
