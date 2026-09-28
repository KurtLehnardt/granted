import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  opportunityEmbedText,
  planEmbedding,
  countRemoved,
  countBySource,
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

  test("a dimensionality change under the SAME model forces a full re-embed (BLOCKER regression guard)", () => {
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

  test("forceFullReembed escalates to a full re-embed even when model and dims both matched " +
    "(BLOCKER: the embedder's real output can differ from a configured dims value the caller " +
    "couldn't verify up front, e.g. EMBEDDINGS_DIMENSIONS unset for a non-OpenAI endpoint)", () => {
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

  test("dims given: a not-yet-embedded record's cached vector of a different length is dropped, not kept mixed-dimension (BLOCKER)", () => {
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

  test("dims given: a REUSED record whose cached vector doesn't match is dropped too (BLOCKER) — " +
    "planEmbedding can hand back a `reused` list built from a configured dims value the embedder " +
    "didn't actually honor (e.g. EMBEDDINGS_DIMENSIONS unset), so this is the last line of defense " +
    "against writing a mixed-dimension corpus", () => {
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

  test("during a FULL re-embed: never saves, even though prior (old-model) vectors exist — " +
    "mixing them in under the new model's label would silently corrupt retrieval", () => {
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

  test("during a PARTIAL re-embed: saves reused + embedded-so-far + cached not-yet-embedded", () => {
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

  test("dims BLOCKER: a stop mid-embedding never keeps a prior whose embedding length differs from this run's dims, even if fullReembed is (wrongly) false", () => {
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

  test("dims BLOCKER: an EMBEDDINGS_DIMENSIONS change under the same model leaves the corpus untouched on stop, like fullReembed", () => {
    // Mirrors what refresh-corpus.mjs does: planEmbedding sets fullReembed=true when
    // priorDims !== dims, so this stop must behave exactly like a full re-embed's stop.
    const priorById = new Map([["a", { ...opp("a"), embedding: [1, 2, 3] }]]);
    const outcome = computeStopOutcome({
      stoppedAt,
      duringEmbedding: true,
      fullReembed: true, // as planEmbedding would report for a same-model dims change
      reused: [],
      embeddedSoFar: [opp("z")],
      notYetEmbedded: [opp("a")],
      priorById,
      dims: 1536,
    });
    assert.equal(outcome.save, false);
    assert.deepEqual(outcome.corpus, []);
  });

  test("dims BLOCKER repro: EMBEDDINGS_DIMENSIONS unset, native embedder dim changed under the same " +
    "model — using the RUN's real dims (from embeddedSoFar, not the configured/meta value that " +
    "trivially matched) drops the stale-dim priors instead of saving a mixed corpus", () => {
    // Mirrors refresh-corpus.mjs's applyStop: EMBEDDINGS_DIMENSIONS is unset (any non-OpenAI
    // endpoint), so the caller's `dims` param would otherwise fall back to existingMeta.dims (16),
    // which trivially equals priorDims (16) — planEmbedding never flags fullReembed, and `reused`
    // ends up holding 16-dim vectors even though the embedder now natively returns 8.
    const priorById = new Map([["b", { ...opp("b"), embedding: new Array(16).fill(0) }]]); // not-yet-embedded's cache
    const realDims = 8; // what the embedder actually returned this run
    const outcome = computeStopOutcome({
      stoppedAt,
      duringEmbedding: true,
      fullReembed: false, // wrongly false, per the scenario above
      reused: [{ ...opp("a"), embedding: new Array(16).fill(0) }], // stale 16-dim reused vector
      embeddedSoFar: [{ ...opp("z"), embedding: new Array(8).fill(0) }],
      notYetEmbedded: [opp("b")],
      priorById,
      dims: realDims,
    });
    assert.equal(outcome.save, true);
    // "a" (stale 16-dim reused) and "b" (stale 16-dim cache) are both dropped; only the 8-dim "z" survives.
    assert.deepEqual(outcome.corpus.map((o) => o.id), ["z"]);
    assert.ok(outcome.corpus.every((o) => o.embedding?.length === realDims));
  });

  test("meta-without-dims (legacy corpus) + a same-model dims change: derives priorDims from an " +
    "actual prior vector — a stop leaves the corpus untouched, and a completed run is all new-dims", () => {
    // Mirrors refresh-corpus.mjs: existingMeta.dims ?? priorById.values().next().value?.embedding?.length.
    const priorById = new Map([
      ["a", { embedding: new Array(16).fill(0), text: opportunityEmbedText(opp("a")) }],
      ["b", { embedding: new Array(16).fill(0), text: opportunityEmbedText(opp("b")) }],
    ]);
    const existingMeta: { dims?: number } = {};
    const priorDims = existingMeta.dims ?? priorById.values().next().value?.embedding?.length;
    assert.equal(priorDims, 16);

    const incoming = [opp("a"), opp("b"), opp("c")];
    // EMBEDDINGS_DIMENSIONS is unset (non-OpenAI endpoint), so the configured dims trivially equal
    // priorDims and planEmbedding doesn't yet know the embedder now natively returns 8.
    const plan = planEmbedding(incoming, priorById, "same-model", "same-model", priorDims, priorDims);
    assert.equal(plan.fullReembed, false);

    // The first embedded batch reveals the embedder's real (new) dims — embedAll would signal
    // `escalate` here, and main() replans as a full re-embed.
    const fullPlan = planEmbedding(incoming, priorById, "same-model", "same-model", priorDims, priorDims, true);
    assert.equal(fullPlan.fullReembed, true);
    assert.equal(fullPlan.reused.length, 0);

    const priorByIdOpps = new Map([
      ["a", opp("a")],
      ["b", opp("b")],
    ]);
    const stopOutcome = computeStopOutcome({
      stoppedAt: "2026-09-27T00:00:00.000Z",
      duringEmbedding: true,
      fullReembed: fullPlan.fullReembed,
      reused: fullPlan.reused,
      embeddedSoFar: [{ ...opp("a"), embedding: new Array(8).fill(0) }],
      notYetEmbedded: [opp("b"), opp("c")],
      priorById: priorByIdOpps,
      dims: 8,
    });
    assert.equal(stopOutcome.save, false);
    assert.deepEqual(stopOutcome.corpus, []);

    // A completed (non-stopped) full re-embed: every record ends up embedded fresh at the new dims.
    const embeddedAll = fullPlan.toEmbed.map((o) => ({ ...o, embedding: new Array(8).fill(0) }));
    const final = [...fullPlan.reused, ...embeddedAll];
    assert.equal(final.length, incoming.length);
    assert.ok(final.every((o) => o.embedding?.length === 8));
  });
});
