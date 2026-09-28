import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { allocateCap, selectCorpusWithinCap, DEFAULT_SOURCE_WEIGHTS } from "../selection";
import type { Opportunity } from "../../types";

function opp(over: Partial<Opportunity> & { id: string; source: string }): Opportunity {
  return {
    kind: "grant",
    program: "Program",
    agency: "Agency",
    description: "A description long enough to be realistic here.",
    ...over,
  } as Opportunity;
}

describe("allocateCap", () => {
  test("splits proportionally to weight when every source has plenty available", () => {
    const alloc = allocateCap(
      { "grants.gov": 1000, sbir: 1000, usaspending: 1000, "assistance-listings": 1000 },
      1000,
      { "grants.gov": 2, sbir: 2, usaspending: 1, "assistance-listings": 1 },
    );
    assert.equal(alloc["grants.gov"] + alloc.sbir + alloc.usaspending + alloc["assistance-listings"], 1000);
    // 2:2:1:1 weights -> grants.gov and sbir get the larger shares.
    assert.ok(alloc["grants.gov"] > alloc.usaspending);
    assert.ok(alloc.sbir > alloc["assistance-listings"]);
  });

  test("never exceeds a source's availability and redistributes the rest", () => {
    // Weighted heavily enough that its weight x availability share would
    // otherwise exceed its 5 available records.
    const alloc = allocateCap(
      { "grants.gov": 5, sbir: 1000, usaspending: 1000, "assistance-listings": 1000 },
      1000,
      { "grants.gov": 100, sbir: 1, usaspending: 1, "assistance-listings": 1 },
    );
    assert.equal(alloc["grants.gov"], 5);
    assert.equal(alloc["grants.gov"] + alloc.sbir + alloc.usaspending + alloc["assistance-listings"], 1000);
  });

  test("splits by weight x availability, not weight alone", () => {
    // A low-availability, high-weight source shouldn't out-earn a
    // high-availability, low-weight one just because of its weight.
    const alloc = allocateCap(
      { "grants.gov": 1521, sbir: 260, usaspending: 106, "assistance-listings": 2872 },
      1000,
      { "grants.gov": 2, sbir: 2, usaspending: 1, "assistance-listings": 1 },
    );
    assert.ok(alloc["grants.gov"] > alloc["assistance-listings"]);
    assert.ok(alloc["assistance-listings"] > alloc.sbir);
    assert.ok(alloc.sbir > alloc.usaspending);
    // Weight alone (2:2:1:1) would starve assistance-listings near its 1-slot
    // floor; weight x availability keeps it close to grants.gov's share.
    assert.ok(alloc["assistance-listings"] > 300);
    const total = alloc["grants.gov"] + alloc.sbir + alloc.usaspending + alloc["assistance-listings"];
    assert.equal(total, 1000);
  });

  test("every present source gets at least one slot when the cap allows", () => {
    const alloc = allocateCap({ "grants.gov": 1, sbir: 1, usaspending: 1, "assistance-listings": 1 }, 4);
    assert.equal(alloc["grants.gov"], 1);
    assert.equal(alloc.sbir, 1);
    assert.equal(alloc.usaspending, 1);
    assert.equal(alloc["assistance-listings"], 1);
  });

  test("absent sources are simply skipped", () => {
    const alloc = allocateCap({ "grants.gov": 10 }, 1000);
    assert.deepEqual(alloc, { "grants.gov": 10 });
  });

  test("total allocation never exceeds the cap", () => {
    const alloc = allocateCap({ a: 3, b: 3, c: 3 }, 5, { a: 1, b: 1, c: 1 });
    const total = Object.values(alloc).reduce((s, n) => s + n, 0);
    assert.ok(total <= 5);
  });
});

describe("selectCorpusWithinCap", () => {
  test("no-op (besides dropping expired) when already at/under cap", () => {
    const records = [opp({ id: "a", source: "grants.gov" }), opp({ id: "b", source: "sbir" })];
    const out = selectCorpusWithinCap(records, 10);
    assert.equal(out.length, 2);
  });

  test("never includes a past-award record (sbir-award-* or a closed usaspending contract)", () => {
    const records = [
      opp({ id: "sbir-award-1", source: "sbir" }),
      opp({ id: "usasp-1", source: "usaspending", status: "closed" }),
      opp({ id: "sbir-open-1", source: "sbir" }),
      opp({ id: "grants-1", source: "grants.gov" }),
    ];
    const out = selectCorpusWithinCap(records, 10);
    assert.deepEqual(out.map((o) => o.id).sort(), ["grants-1", "sbir-open-1"]);
  });

  test("never includes an expired record", () => {
    const records = [
      opp({ id: "a", source: "grants.gov", deadline: "2000-01-01" }),
      opp({ id: "b", source: "grants.gov" }),
    ];
    const out = selectCorpusWithinCap(records, 1);
    assert.deepEqual(out.map((o) => o.id), ["b"]);
  });

  test("every source with records is represented in the trimmed set", () => {
    const records = [
      ...Array.from({ length: 50 }, (_, i) => opp({ id: `g${i}`, source: "grants.gov" })),
      ...Array.from({ length: 50 }, (_, i) => opp({ id: `s${i}`, source: "sbir" })),
      ...Array.from({ length: 50 }, (_, i) => opp({ id: `u${i}`, source: "usaspending" })),
      ...Array.from({ length: 50 }, (_, i) => opp({ id: `a${i}`, source: "assistance-listings" })),
    ];
    const out = selectCorpusWithinCap(records, 40, DEFAULT_SOURCE_WEIGHTS, Date.now());
    const sources = Array.from(new Set(out.map((o) => o.source)));
    assert.deepEqual(sources.sort(), ["assistance-listings", "grants.gov", "sbir", "usaspending"]);
    assert.equal(out.length, 40);
  });

  test("grants.gov: open before forecasted, then soonest deadline first", () => {
    const future = new Date(Date.now() + 90 * 864e5).toISOString().slice(0, 10);
    const soon = new Date(Date.now() + 5 * 864e5).toISOString().slice(0, 10);
    const records = [
      opp({ id: "forecasted", source: "grants.gov", forecasted: true, deadline: soon }),
      opp({ id: "open-far", source: "grants.gov", forecasted: false, deadline: future }),
      opp({ id: "open-soon", source: "grants.gov", forecasted: false, deadline: soon }),
    ];
    const out = selectCorpusWithinCap(records, 2);
    assert.deepEqual(out.map((o) => o.id), ["open-soon", "open-far"]);
  });

  test("sbir: open solicitations rank by deadline, ahead of one with no deadline at all", () => {
    // Every "sbir" record reaching selection is a genuine open solicitation —
    // "sbir-award-*" ids (the only past-award shape) are dropped before this
    // ever runs (lib/corpus/pastAwards.ts) — so these fixtures are all
    // solicitation-shaped, not award-shaped.
    const soon = new Date(Date.now() + 10 * 864e5).toISOString().slice(0, 10);
    const later = new Date(Date.now() + 90 * 864e5).toISOString().slice(0, 10);
    const records = [
      opp({ id: "no-deadline", source: "sbir" }),
      opp({ id: "soon", source: "sbir", deadline: soon }),
      opp({ id: "later", source: "sbir", deadline: later }),
    ];
    const out = selectCorpusWithinCap(records, 2);
    assert.deepEqual(out.map((o) => o.id), ["later", "soon"]);
  });

  test("assistance-listings: business/research/technology relevance wins ties", () => {
    const records = [
      opp({ id: "generic", source: "assistance-listings", program: "Community support", description: "General community support program." }),
      opp({ id: "relevant", source: "assistance-listings", program: "Small business technology innovation", description: "Business research and technology commercialization support." }),
    ];
    const out = selectCorpusWithinCap(records, 1);
    assert.deepEqual(out.map((o) => o.id), ["relevant"]);
  });
});
