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

  test("a changed embedding model forces a full re-embed, even for unchanged records", () => {
    const incoming = [opp("a")];
    const text = opportunityEmbedText(incoming[0]);
    const prior = new Map([["a", { embedding: [1, 2, 3], text }]]);
    const plan = planEmbedding(incoming, prior, "text-embedding-3-small", "nomic-embed-text");
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
});
