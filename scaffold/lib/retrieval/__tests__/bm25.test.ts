import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { buildBM25Index, bm25Query, tokenize, getBM25Index } from "../bm25";
import type { Opportunity } from "../../types";

/**
 * Hybrid retrieval (instant-cards perf work) — BM25 keyword index.
 * Perf: must stay well under a second even at 20,000 records (generous bound;
 * the prose target is <100ms per query, this just guards against a real
 * regression without being flaky on a slow CI box).
 */

function opp(over: Partial<Opportunity> & Pick<Opportunity, "id">): Opportunity {
  return {
    source: "grants.gov",
    kind: "grant",
    program: "A generic filler program",
    agency: "Generic Agency",
    description: "A generic filler description about federal funding opportunities.",
    eligibility: "US small business.",
    ...over,
  };
}

test("tokenize: lowercases, strips punctuation, drops stopwords and single chars", () => {
  assert.deepEqual(tokenize("The Quick-Brown Fox, a jumper!"), ["quick", "brown", "fox", "jumper"]);
});

describe("bm25Query", () => {
  test("a rare exact keyword scores its document far above generic filler docs", () => {
    const target = opp({
      id: "target-1",
      program: "Bathymetric Sonar Seabed Mapping Initiative",
      description: "Supports bathymetric sonar seabed mapping research for coastal resilience.",
    });
    const fillers = Array.from({ length: 50 }, (_, i) => opp({ id: `filler-${i}` }));
    const corpus = [...fillers.slice(0, 25), target, ...fillers.slice(25)];
    const index = buildBM25Index(corpus);

    const hits = bm25Query(index, "Our platform improves bathymetric sonar seabed mapping for harbors.");
    assert.ok(hits.length > 0, "the rare keyword must produce at least one hit");
    assert.equal(hits[0].id, "target-1", "the exact-keyword doc must rank first");
  });

  test("a query with no term overlap returns no hits (never a false match)", () => {
    const corpus = [opp({ id: "a" }), opp({ id: "b" })];
    const index = buildBM25Index(corpus);
    const hits = bm25Query(index, "");
    assert.deepEqual(hits, []);
  });

  test("perf: a synthetic 20,000-record corpus queries in well under a second", () => {
    const corpus: Opportunity[] = Array.from({ length: 20_000 }, (_, i) =>
      opp({
        id: `opp-${i}`,
        program: `Program ${i} on advanced manufacturing topic ${i % 200}`,
        description: `Funding opportunity ${i} for small business research in sector ${i % 50}, covering robotics, sensing, and materials science.`,
        agency: `Agency ${i % 30}`,
      }),
    );

    const buildStart = Date.now();
    const index = buildBM25Index(corpus);
    const buildMs = Date.now() - buildStart;

    const queryStart = Date.now();
    const hits = bm25Query(index, "advanced manufacturing robotics sensing materials science small business");
    const queryMs = Date.now() - queryStart;

    assert.ok(hits.length > 0);
    // Generous bound (prose target is <100ms/query) — guards against a real
    // algorithmic regression (e.g. an accidental O(n^2) scan) without being
    // flaky on a slow CI box.
    assert.ok(queryMs < 1000, `query took ${queryMs}ms, expected <1000ms`);
    assert.ok(buildMs < 5000, `index build took ${buildMs}ms, expected <5000ms`);
  });

  test("getBM25Index caches by corpus array identity", () => {
    const corpus = [opp({ id: "a" }), opp({ id: "b" })];
    const first = getBM25Index(corpus);
    const second = getBM25Index(corpus);
    assert.equal(first, second, "the same corpus array reference must reuse the cached index");

    const otherCorpus = [opp({ id: "a" }), opp({ id: "b" })];
    const third = getBM25Index(otherCorpus);
    assert.notEqual(first, third, "a different corpus array reference must rebuild the index");
  });
});
