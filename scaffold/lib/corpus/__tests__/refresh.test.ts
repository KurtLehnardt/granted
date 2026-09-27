import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  opportunityEmbedText,
  planEmbedding,
  countRemoved,
  dedupeById,
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

describe("dedupeById", () => {
  test("keeps the last occurrence for a duplicate id", () => {
    const result = dedupeById([opp("a", "first"), opp("b"), opp("a", "second")]);
    assert.equal(result.length, 2);
    assert.equal(result.find((o) => o.id === "a")?.description, "second");
  });
});
