/**
 * MVP data-breadth — corpus invariants (hermetic; no network).
 *
 * Guards the acceptance criteria for the multi-source ingest so a future
 * re-assembly can't silently regress them:
 *  - the original 476 grants.gov opportunities are still present + embedded;
 *  - every new resource type (assistance / loan / scholarship / rd / procurement)
 *    is represented with a healthy count;
 *  - the new evergreen records (assistance listings, ongoing SBIR/STTR) carry NO
 *    deadline and NO funding floor/ceiling, so nothing reads "closing soon" or
 *    inflates the funding summary (plan A0/I5);
 *  - every record validates against the A0 OpportunitySchema and is embedded at
 *    ONE consistent dimension. The committed snapshot is 512-d (OpenAI
 *    text-embedding-3-small), but a self-hoster who runs `npm run data:embed`
 *    with a local embedder re-embeds the whole corpus at that model's dimension
 *    (e.g. nomic-embed-text is 768-d). So we derive the dimension from the corpus
 *    itself and require uniformity, rather than hardcoding 512 — that would fail
 *    `npm test` after a perfectly valid local re-embed. Query/corpus dimension
 *    MATCHING is enforced separately at runtime (assertEmbeddingDimsMatch).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { OpportunitySchema } from "../../lib/contracts/opportunity";
import { isPastAward } from "../../lib/corpus/pastAwards";
import { normalizeStateName } from "../../lib/location";

const here = dirname(fileURLToPath(import.meta.url));
const corpus = JSON.parse(
  readFileSync(join(here, "../../data/opportunities.json"), "utf8"),
) as Array<Record<string, unknown>>;

const opps = corpus;
const by = (pred: (o: any) => boolean) => opps.filter(pred);

// The corpus embedding dimension, DERIVED from the corpus (not hardcoded) so a
// local re-embed at a different dimension still validates — see the file header.
// 512 for the committed OpenAI snapshot; whatever the local embedder emits after
// `npm run data:embed`. Tests assert every record matches this one dimension.
const EXPECTED_DIM: number =
  (opps.find((o: any) => Array.isArray(o.embedding) && o.embedding.length > 0) as any)?.embedding?.length ?? 0;

test("at least the original 476 grants.gov opportunities are present and embedded", () => {
  // Floor, not exact match (matches the "healthy count" idiom below): the
  // original MVP ingest shipped exactly 476, but a later broader refresh
  // (npm run data:refresh, fetching ALL open grants.gov listings nationally
  // instead of a 14-keyword subset) legitimately grows this over time as
  // real government supply changes. An exact-equality check would fail on
  // every future honest refresh; this still catches a real regression
  // (the corpus silently shrinking below its historical baseline).
  const grants = by((o) => o.source === "grants.gov");
  assert.ok(grants.length >= 476, `expected >= 476 grants.gov opps, got ${grants.length}`);
  assert.ok(EXPECTED_DIM > 0, "corpus must be embedded (positive dimension)");
  assert.ok(
    grants.every((o: any) => Array.isArray(o.embedding) && o.embedding.length === EXPECTED_DIM),
    `every grant must keep its ${EXPECTED_DIM}-dim embedding (uniform with the rest of the corpus)`,
  );
});

test("each new resource type is represented with a healthy count", () => {
  const counts: Record<string, number> = {};
  for (const o of opps) counts[(o as any).kind] = (counts[(o as any).kind] || 0) + 1;
  // ≥N per new type (the ingest acceptance). Thresholds are deliberately well
  // below what we ship (assistance 240 / loan 45 / scholarship 30) so
  // trimming tweaks don't spuriously fail the gate.
  assert.ok(counts.assistance >= 25, `assistance=${counts.assistance}`);
  assert.ok(counts.loan >= 10, `loan=${counts.loan}`);
  assert.ok(counts.scholarship >= 10, `scholarship=${counts.scholarship}`);
});

test("new sources are present under the A0 source vocabulary", () => {
  const sources = new Set(opps.map((o: any) => o.source));
  for (const s of ["grants.gov", "assistance-listings", "ca-grants", "il-grants", "nc-grants"]) {
    assert.ok(sources.has(s), `expected source ${s} in the corpus`);
  }
});

test("ut-grants is a recognized source (opt-in, off by default -- not required to be present in the committed corpus)", () => {
  // Utah ships opt-in and off by default (see lib/searchSettings.ts's
  // DEFAULT_STATE_SOURCES), so unlike CA/IL/NC above, there's no floor-count
  // assertion requiring ut-grants records to actually exist here -- whether
  // to commit real fetched Utah data is a separate, later decision. This
  // only guards that the source id itself is in the recognized vocabulary
  // and, if present, validates like every other record (see the
  // OpportunitySchema test below, which already covers every record).
  const r = OpportunitySchema.safeParse({
    id: "ut-test",
    source: "ut-grants",
    kind: "grant",
    program: "Test Program",
    agency: "Utah state agency",
    description: "A placeholder description long enough to clear the schema's own length-free validation easily.",
  });
  assert.ok(r.success, "ut-grants must be a valid OpportunitySource");
});

test("each state-grant source has a healthy count (floor, not exact match -- see the grants.gov test above for why)", () => {
  // Live counts at the time this was written: ca-grants 169, il-grants 113,
  // nc-grants 74 (confirmed against the real refresh this committed). Floors
  // set well below those so a future honest refresh (the state's own
  // listings naturally changing) doesn't spuriously fail this gate -- it
  // still catches a real regression (a source silently breaking/returning
  // near-zero rows).
  const counts: Record<string, number> = {};
  for (const o of opps) counts[(o as any).source] = (counts[(o as any).source] || 0) + 1;
  assert.ok((counts["ca-grants"] ?? 0) >= 50, `ca-grants=${counts["ca-grants"]}`);
  assert.ok((counts["il-grants"] ?? 0) >= 30, `il-grants=${counts["il-grants"]}`);
  assert.ok((counts["nc-grants"] ?? 0) >= 20, `nc-grants=${counts["nc-grants"]}`);
});

test("every state-grant record's geography resolves to a real state via the shared normalizer", () => {
  // Catches a scraper bug that writes a garbled/misspelled state string
  // before it ever reaches the match-results location filter (lib/
  // opportunities/filterSort.ts), which trusts this field completely.
  const stateGrants = by((o) => ["ca-grants", "il-grants", "nc-grants"].includes(o.source as string));
  assert.ok(stateGrants.length > 0, "expected at least one state-grant record");
  for (const o of stateGrants as any[]) {
    const resolved = normalizeStateName(o.geography);
    assert.ok(resolved, `${o.id} (source ${o.source}) has an unresolvable geography: ${JSON.stringify(o.geography)}`);
  }
  const caOk = stateGrants.filter((o: any) => o.source === "ca-grants").every((o: any) => normalizeStateName(o.geography) === "California");
  const ilOk = stateGrants.filter((o: any) => o.source === "il-grants").every((o: any) => normalizeStateName(o.geography) === "Illinois");
  const ncOk = stateGrants.filter((o: any) => o.source === "nc-grants").every((o: any) => normalizeStateName(o.geography) === "North Carolina");
  assert.ok(caOk, "every ca-grants record must resolve to California, not some other state");
  assert.ok(ilOk, "every il-grants record must resolve to Illinois, not some other state");
  assert.ok(ncOk, "every nc-grants record must resolve to North Carolina, not some other state");
});

test("no past-award record (SBIR/STTR award or closed USAspending contract) is in the committed corpus", () => {
  const pastAwards = (opps as any[]).filter(isPastAward);
  assert.deepEqual(pastAwards.map((o) => o.id), []);
});

test("evergreen records (assistance listings) carry no deadline and no funding", () => {
  const evergreen = by((o) => o.source === "assistance-listings");
  assert.ok(evergreen.length > 0);
  for (const o of evergreen as any[]) {
    assert.equal(o.deadline, undefined, `${o.id} must have no deadline (evergreen)`);
    assert.equal(o.fundingLow, undefined, `${o.id} must have no fundingLow`);
    assert.equal(o.fundingHigh, undefined, `${o.id} must have no fundingHigh`);
    assert.notEqual(o.forecasted, true, `${o.id} must not be marked forecasted`);
  }
});

test("every corpus record validates against OpportunitySchema and is embedded at a uniform dimension", () => {
  assert.ok(EXPECTED_DIM > 0, "corpus must be embedded (positive dimension)");
  for (const o of opps) {
    const r = OpportunitySchema.safeParse(o);
    assert.ok(r.success, `record ${(o as any).id} failed schema: ${r.success ? "" : JSON.stringify(r.error.issues.slice(0, 2))}`);
    assert.ok(
      Array.isArray((o as any).embedding) && (o as any).embedding.length === EXPECTED_DIM,
      `${(o as any).id} missing ${EXPECTED_DIM}-dim embedding`,
    );
  }
});
