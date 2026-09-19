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

test("the original 476 grants.gov opportunities are preserved and embedded", () => {
  const grants = by((o) => o.source === "grants.gov");
  assert.equal(grants.length, 476, "expected the original 476 grants.gov opps");
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
  // below what we ship (assistance 240 / loan 45 / scholarship 30 / rd 130 /
  // procurement 47) so trimming tweaks don't spuriously fail the gate.
  assert.ok(counts.assistance >= 25, `assistance=${counts.assistance}`);
  assert.ok(counts.loan >= 10, `loan=${counts.loan}`);
  assert.ok(counts.scholarship >= 10, `scholarship=${counts.scholarship}`);
  assert.ok(counts.rd >= 20, `rd=${counts.rd}`);
  assert.ok(counts.procurement >= 15, `procurement=${counts.procurement}`);
});

test("new sources are present under the A0 source vocabulary", () => {
  const sources = new Set(opps.map((o: any) => o.source));
  for (const s of ["grants.gov", "assistance-listings", "sbir", "usaspending"]) {
    assert.ok(sources.has(s), `expected source ${s} in the corpus`);
  }
});

test("evergreen records (assistance + SBIR) carry no deadline and no funding", () => {
  const evergreen = by((o) => o.source === "assistance-listings" || o.source === "sbir");
  assert.ok(evergreen.length > 0);
  for (const o of evergreen as any[]) {
    assert.equal(o.deadline, undefined, `${o.id} must have no deadline (evergreen)`);
    assert.equal(o.fundingLow, undefined, `${o.id} must have no fundingLow`);
    assert.equal(o.fundingHigh, undefined, `${o.id} must have no fundingHigh`);
    assert.notEqual(o.forecasted, true, `${o.id} must not be marked forecasted`);
  }
});

test("procurement records honestly frame gov-as-customer and link to a real award", () => {
  const proc = by((o) => o.kind === "procurement") as any[];
  assert.ok(proc.length > 0);
  for (const o of proc) {
    assert.match(String(o.description), /government|customer|procurement|contract/i);
    // Every procurement URL that exists points at the real USAspending award page.
    if (o.url) assert.match(String(o.url), /^https:\/\/www\.usaspending\.gov\/award\//);
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
