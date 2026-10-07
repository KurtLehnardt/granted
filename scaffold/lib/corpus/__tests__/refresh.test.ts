import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { refreshEmbedsBuiltinVectors } from "../refresh";
import { getSpace } from "../../embeddings/spaces";
import {
  opportunityEmbedText,
  planEmbedding,
  countRemoved,
  countBySource,
  excludeDeselectedSources,
  findUnhealthySources,
  dedupeById,
  mergePartialSave,
  computeStopOutcome,
  LEGACY_EMBEDDING_MODEL,
} from "../refresh";

function opp(id: string, description = "desc", program = "Program", agency = "Agency") {
  return { id, program, agency, description, source: "grants.gov", kind: "grant" } as any;
}

describe("opportunityEmbedText", () => {
  test("joins program/agency/description and caps length", () => {
    const text = opportunityEmbedText(opp("a", "d", "P", "Ag"));
    assert.equal(text, "P. Ag. d");
  });
});

describe("planEmbedding", () => {
  test("reuses an unchanged record's embedding", () => {
    const incoming = [opp("a")];
    const text = opportunityEmbedText(incoming[0]);
    const prior = new Map([["a", { embedding: [1, 2, 3], text }]]);
    const plan = planEmbedding(incoming, prior, "text-embedding-3-small", "text-embedding-3-small");
    assert.equal(plan.reused.length, 1);
    assert.equal(plan.toEmbed.length, 0);
    assert.deepEqual(plan.reused[0].embedding, [1, 2, 3]);
    assert.equal(plan.added, 0);
    assert.equal(plan.updated, 0);
    assert.equal(plan.fullReembed, false);
  });

  test("re-embeds when the text changed, counts it as updated", () => {
    const incoming = [opp("a", "new description")];
    const prior = new Map([["a", { embedding: [1], text: "Program. Agency. old description" }]]);
    const plan = planEmbedding(incoming, prior, "text-embedding-3-small", "text-embedding-3-small");
    assert.equal(plan.toEmbed.length, 1);
    assert.equal(plan.reused.length, 0);
    assert.equal(plan.updated, 1);
    assert.equal(plan.added, 0);
  });

  test("embeds a brand-new id, counts it as added", () => {
    const plan = planEmbedding([opp("new")], new Map(), "text-embedding-3-small", "text-embedding-3-small");
    assert.equal(plan.toEmbed.length, 1);
    assert.equal(plan.added, 1);
    assert.equal(plan.updated, 0);
  });

  test("a prior embedding whose length doesn't match meta.dims is re-embedded, not trusted", () => {
    const incoming = [opp("a")];
    const text = opportunityEmbedText(incoming[0]);
    const prior = new Map([["a", { embedding: [1, 2, 3], text }]]); // 3 dims
    const plan = planEmbedding(incoming, prior, "text-embedding-3-small", "text-embedding-3-small", 1536);
    assert.equal(plan.reused.length, 0);
    assert.equal(plan.toEmbed.length, 1);
    assert.equal(plan.updated, 1);
  });

  test("a prior embedding matching meta.dims is still reused", () => {
    const incoming = [opp("a")];
    const text = opportunityEmbedText(incoming[0]);
    const prior = new Map([["a", { embedding: [1, 2, 3], text }]]);
    const plan = planEmbedding(incoming, prior, "text-embedding-3-small", "text-embedding-3-small", 3);
    assert.equal(plan.reused.length, 1);
    assert.equal(plan.toEmbed.length, 0);
  });

  test("a dimensionality change under the same model forces a full re-embed", () => {
    const incoming = [opp("a")];
    const text = opportunityEmbedText(incoming[0]);
    const prior = new Map([["a", { embedding: [1, 2, 3], text }]]); // 3-dim corpus
    const plan = planEmbedding(incoming, prior, "text-embedding-3-small", "text-embedding-3-small", 1536, 3);
    assert.equal(plan.fullReembed, true);
    assert.equal(plan.reused.length, 0);
    assert.equal(plan.toEmbed.length, 1);
  });

  test("matching priorDims and dims: no forced full re-embed", () => {
    const incoming = [opp("a")];
    const text = opportunityEmbedText(incoming[0]);
    const prior = new Map([["a", { embedding: [1, 2, 3], text }]]);
    const plan = planEmbedding(incoming, prior, "text-embedding-3-small", "text-embedding-3-small", 3, 3);
    assert.equal(plan.fullReembed, false);
    assert.equal(plan.reused.length, 1);
  });

  test("a changed embedding model forces a full re-embed, even for unchanged records", () => {
    const incoming = [opp("a")];
    const text = opportunityEmbedText(incoming[0]);
    const prior = new Map([["a", { embedding: [1, 2, 3], text }]]);
    const plan = planEmbedding(incoming, prior, "text-embedding-3-small", "nomic-embed-text");
    assert.equal(plan.fullReembed, true);
    assert.equal(plan.reused.length, 0);
    assert.equal(plan.toEmbed.length, 1);
  });

  test("forceFullReembed forces a full re-embed even when model and dims match", () => {
    const incoming = [opp("a")];
    const text = opportunityEmbedText(incoming[0]);
    const prior = new Map([["a", { embedding: [1, 2, 3], text }]]);
    const plan = planEmbedding(incoming, prior, "text-embedding-3-small", "text-embedding-3-small", 3, 3, true);
    assert.equal(plan.fullReembed, true);
    assert.equal(plan.reused.length, 0);
    assert.equal(plan.toEmbed.length, 1);
  });

  test("an untagged prior corpus is assumed to be the legacy OpenAI model", () => {
    const incoming = [opp("a")];
    const text = opportunityEmbedText(incoming[0]);
    const prior = new Map([["a", { embedding: [1, 2, 3], text }]]);
    const same = planEmbedding(incoming, prior, undefined, LEGACY_EMBEDDING_MODEL);
    assert.equal(same.fullReembed, false);
    assert.equal(same.reused.length, 1);

    const different = planEmbedding(incoming, prior, undefined, "nomic-embed-text");
    assert.equal(different.fullReembed, true);
  });
});

describe("countRemoved", () => {
  test("counts prior ids absent from the final set", () => {
    assert.equal(countRemoved(["a", "b", "c"], new Set(["a", "c"])), 1);
    assert.equal(countRemoved([], new Set()), 0);
  });
});

describe("countBySource", () => {
  test("tallies records per source", () => {
    const counts = countBySource([opp("a"), { ...opp("b"), source: "sbir" }, opp("c")]);
    assert.deepEqual(counts, { "grants.gov": 2, sbir: 1 });
  });
});

describe("findUnhealthySources", () => {
  test("flags a source that had records before and comes back empty", () => {
    const issues = findUnhealthySources({ "grants.gov": 476, sbir: 130 }, { "grants.gov": 0, sbir: 130 });
    assert.equal(issues.length, 1);
    assert.match(issues[0], /grants\.gov/);
  });
  test("flags a source that drops by more than half", () => {
    const issues = findUnhealthySources({ "grants.gov": 1000 }, { "grants.gov": 300 });
    assert.equal(issues.length, 1);
  });
  test("does not flag a small source or a modest drop", () => {
    assert.deepEqual(findUnhealthySources({ procurement: 4 }, { procurement: 0 }), []);
    assert.deepEqual(findUnhealthySources({ "grants.gov": 1000 }, { "grants.gov": 900 }), []);
  });
  test("a brand-new source with no prior count is never flagged", () => {
    assert.deepEqual(findUnhealthySources({}, { sbir: 130 }), []);
  });
});

describe("excludeDeselectedSources", () => {
  const TOGGLEABLE = ["ca-grants", "il-grants", "nc-grants", "ut-grants"];

  test("drops a toggleable source's prior count when it's not in the selected set", () => {
    const filtered = excludeDeselectedSources({ "ca-grants": 27, "ut-grants": 32 }, TOGGLEABLE, ["ca-grants"]);
    assert.deepEqual(filtered, { "ca-grants": 27 });
  });

  test("leaves non-toggleable sources (grants.gov, sbir, ...) untouched regardless of selection", () => {
    const filtered = excludeDeselectedSources({ "grants.gov": 461, "ut-grants": 32 }, TOGGLEABLE, []);
    assert.deepEqual(filtered, { "grants.gov": 461 });
  });

  test("leaves a selected toggleable source's count untouched", () => {
    const filtered = excludeDeselectedSources({ "ca-grants": 27, "il-grants": 18 }, TOGGLEABLE, ["ca-grants", "il-grants"]);
    assert.deepEqual(filtered, { "ca-grants": 27, "il-grants": 18 });
  });

  test("REGRESSION (real bug, caught before merge): deselecting Utah must not trip findUnhealthySources " +
    "and abort the whole refresh, even though its fresh count drops to 0", () => {
    const priorCounts = { "grants.gov": 461, "ca-grants": 27, "ut-grants": 32 };
    const freshCounts = { "grants.gov": 465, "ca-grants": 27 }; // ut-grants not fetched this run at all
    const filtered = excludeDeselectedSources(priorCounts, TOGGLEABLE, ["ca-grants"]); // Utah deselected
    assert.deepEqual(findUnhealthySources(filtered, freshCounts), []);
  });

  test("a genuine scrape break in a SELECTED source is still caught, not masked by this exclusion", () => {
    const priorCounts = { "ca-grants": 27, "ut-grants": 32 };
    const freshCounts = { "ca-grants": 2 }; // ca-grants itself broke, not deselected
    const filtered = excludeDeselectedSources(priorCounts, TOGGLEABLE, ["ca-grants"]);
    const issues = findUnhealthySources(filtered, freshCounts);
    assert.equal(issues.length, 1);
    assert.match(issues[0], /ca-grants/);
  });
});

describe("dedupeById", () => {
  test("keeps the last occurrence for a duplicate id", () => {
    const result = dedupeById([opp("a", "first"), opp("b"), opp("a", "second")]);
    assert.equal(result.length, 2);
    assert.equal(result.find((o) => o.id === "a")?.description, "second");
  });
});

describe("mergePartialSave", () => {
  test("keeps reused + embedded-so-far, drops not-yet-embedded records with no prior cache", () => {
    const reused = [opp("a")];
    const embedded = [opp("b")];
    const notYetEmbedded = [opp("c")];
    const result = mergePartialSave(reused, embedded, notYetEmbedded, new Map());
    assert.deepEqual(result.map((o) => o.id).sort(), ["a", "b"]);
  });

  test("a not-yet-embedded record with an existing cached version keeps that previous version", () => {
    const reused = [opp("a")];
    const embedded: ReturnType<typeof opp>[] = [];
    const notYetEmbedded = [opp("c", "fresh description")];
    const prior = new Map([["c", opp("c", "cached description")]]);
    const result = mergePartialSave(reused, embedded, notYetEmbedded, prior);
    assert.equal(result.length, 2);
    assert.equal(result.find((o) => o.id === "c")?.description, "cached description");
  });

  test("never drops or duplicates a reused or embedded record", () => {
    const reused = [opp("a"), opp("b")];
    const embedded = [opp("c")];
    const notYetEmbedded = [opp("a"), opp("d")]; // "a" already reused — must not duplicate
    const prior = new Map([["a", opp("a", "stale")], ["d", opp("d", "cached")]]);
    const result = mergePartialSave(reused, embedded, notYetEmbedded, prior);
    assert.deepEqual(result.map((o) => o.id).sort(), ["a", "b", "c", "d"]);
    assert.equal(result.filter((o) => o.id === "a").length, 1);
  });

  test("no prior map at all: not-yet-embedded records are simply skipped", () => {
    const result = mergePartialSave([opp("a")], [], [opp("b"), opp("c")], new Map());
    assert.deepEqual(result.map((o) => o.id), ["a"]);
  });

  test("dims given: a not-yet-embedded record's cached vector of a different length is dropped", () => {
    const reused = [{ ...opp("a"), embedding: [1, 2, 3] }]; // matches target dims
    const embedded: ReturnType<typeof opp>[] = [];
    const notYetEmbedded = [opp("b"), opp("c")];
    const prior = new Map([
      ["b", { ...opp("b"), embedding: [1, 2, 3] }], // 3 dims — matches target
      ["c", { ...opp("c"), embedding: [1, 2] }], // 2 dims — stale, must be dropped
    ]);
    const result = mergePartialSave(reused, embedded, notYetEmbedded, prior, 3);
    assert.deepEqual(result.map((o) => o.id).sort(), ["a", "b"]);
  });

  test("dims given: a not-yet-embedded record with no cached embedding at all is dropped", () => {
    const prior = new Map([["b", opp("b")]]); // no embedding field
    const result = mergePartialSave([], [], [opp("b")], prior, 3);
    assert.deepEqual(result, []);
  });

  test("dims given: a reused record whose vector length doesn't match is dropped", () => {
    const reused = [
      { ...opp("a"), embedding: [1, 2, 3] }, // 3 dims — stale relative to this run's real 8
      { ...opp("b"), embedding: new Array(8).fill(0) }, // matches
    ];
    const embedded = [{ ...opp("c"), embedding: new Array(8).fill(0) }];
    const result = mergePartialSave(reused, embedded, [], new Map(), 8);
    assert.deepEqual(result.map((o) => o.id).sort(), ["b", "c"]);
  });
});

describe("computeStopOutcome", () => {
  const stoppedAt = "2026-09-27T00:00:00.000Z";

  test("before embedding: never saves, corpus untouched", () => {
    const outcome = computeStopOutcome({
      stoppedAt,
      duringEmbedding: false,
      fullReembed: false,
      reused: [],
      embeddedSoFar: [],
      notYetEmbedded: [],
      priorById: new Map(),
    });
    assert.equal(outcome.save, false);
    assert.deepEqual(outcome.status, { lastStoppedAt: stoppedAt, stopped: true, savedCount: 0 });
  });

  test("during a full re-embed: never saves, even though prior (old-model) vectors exist", () => {
    const priorById = new Map([
      ["a", opp("a")],
      ["b", opp("b")],
    ]); // old-model cached versions, still carrying old-model vectors
    const outcome = computeStopOutcome({
      stoppedAt,
      duringEmbedding: true,
      fullReembed: true,
      reused: [], // always empty during a full re-embed
      embeddedSoFar: [opp("c")], // one batch finished under the NEW model before the stop
      notYetEmbedded: [opp("a"), opp("b")],
      priorById,
    });
    assert.equal(outcome.save, false);
    assert.deepEqual(outcome.corpus, []);
    assert.deepEqual(outcome.status, { lastStoppedAt: stoppedAt, stopped: true, savedCount: 0 });
  });

  test("during a partial re-embed: saves reused + embedded-so-far + cached not-yet-embedded", () => {
    const priorById = new Map([["c", opp("c", "cached")]]);
    const outcome = computeStopOutcome({
      stoppedAt,
      duringEmbedding: true,
      fullReembed: false,
      reused: [opp("a")],
      embeddedSoFar: [opp("b")],
      notYetEmbedded: [opp("c")],
      priorById,
    });
    assert.equal(outcome.save, true);
    assert.deepEqual(outcome.corpus.map((o) => o.id).sort(), ["a", "b", "c"]);
    assert.deepEqual(outcome.status, { lastStoppedAt: stoppedAt, stopped: true, savedCount: 3 });
  });

  test("a partial stop drops priors whose length differs from dims", () => {
    const priorById = new Map([
      ["b", { ...opp("b"), embedding: [1, 2, 3] }], // 3-dim — stale relative to this run's 1536
      ["c", { ...opp("c"), embedding: new Array(1536).fill(0) }], // matches this run's dims
    ]);
    const outcome = computeStopOutcome({
      stoppedAt,
      duringEmbedding: true,
      fullReembed: false,
      reused: [{ ...opp("a"), embedding: new Array(1536).fill(0) }], // matches this run's dims
      embeddedSoFar: [],
      notYetEmbedded: [opp("b"), opp("c")],
      priorById,
      dims: 1536,
    });
    assert.equal(outcome.save, true);
    assert.deepEqual(outcome.corpus.map((o) => o.id).sort(), ["a", "c"]);
  });
});


test("data:refresh embeds built-in vectors only when search is built-in (never CPU work in OpenAI mode)", () => {
  assert.equal(refreshEmbedsBuiltinVectors(getSpace("builtin")), true);
  assert.equal(refreshEmbedsBuiltinVectors(getSpace("openai")), false);
  assert.equal(refreshEmbedsBuiltinVectors(getSpace("custom")), false);
});
