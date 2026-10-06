import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { buildSpaceVectors, planSpaceVectors, spaceDocumentText } from "../spaceVectors.mjs";
import { textHash } from "../vectorFile.mjs";
import { SPACES } from "../spaces.mjs";

/**
 * Corpus refresh with no key: only new or changed records are embedded (by id
 * AND text), in batches, with whatever embedder the space uses. A fake embedder
 * stands in for the model here.
 */

const space = { ...SPACES.builtin, dims: 2 };
const opp = (id: string, description = `About ${id}.`) => ({ id, program: `P ${id}`, agency: "A", description });

function priorFor(opps: ReturnType<typeof opp>[], vector = [1, 0]) {
  return new Map(opps.map((o) => [o.id, { vector, textHash: textHash(spaceDocumentText(space, o)) }]));
}

function fakeEmbedder() {
  const calls: string[][] = [];
  return {
    calls,
    embed: async (texts: string[]) => {
      calls.push(texts);
      return texts.map((t) => [t.length, 0]);
    },
  };
}

describe("spaceDocumentText", () => {
  test("the space's document prefix + the shared program text", () => {
    assert.equal(spaceDocumentText(space, opp("a")), "search_document: P a. A. About a.");
    assert.equal(spaceDocumentText(SPACES.openai, opp("a")), "P a. A. About a.");
  });
});

describe("planSpaceVectors", () => {
  test("reuses by id and text; a changed text or a new id is embedded", () => {
    const [a, b] = [opp("a"), opp("b")];
    const prior = priorFor([a, b]);
    const plan = planSpaceVectors(space, [a, opp("b", "Changed."), opp("c")], prior);
    assert.deepEqual(plan.reused.map((e: { id: string }) => e.id), ["a"]);
    assert.deepEqual(plan.toEmbed.map((e: { id: string }) => e.id), ["b", "c"]);
    assert.equal(plan.updated, 1);
    assert.equal(plan.added, 1);
  });

  test("never reuses a vector of the wrong size (e.g. a different model's)", () => {
    const a = opp("a");
    const plan = planSpaceVectors(space, [a], priorFor([a], [1, 0, 0]));
    assert.equal(plan.reused.length, 0);
    assert.equal(plan.toEmbed.length, 1);
  });
});

describe("buildSpaceVectors", () => {
  test("embeds only what changed, shortest first in batches, and returns entries in corpus order", async () => {
    const [a, b] = [opp("a"), opp("b")];
    const f = fakeEmbedder();
    const corpus = [opp("long", "x".repeat(50)), a, opp("short", "y"), b];
    const progress: Array<[number, number]> = [];
    const r = await buildSpaceVectors(space, corpus, { prior: priorFor([a, b]), embed: f.embed, batch: 1, onProgress: (d: number, t: number) => progress.push([d, t]) });
    assert.deepEqual(r.entries.map((e: { id: string }) => e.id), ["long", "a", "short", "b"]);
    assert.equal(r.reused, 2);
    assert.equal(r.embedded, 2);
    assert.equal(f.calls.length, 2);
    assert.ok(f.calls[0][0].length < f.calls[1][0].length, "shortest first");
    assert.deepEqual(progress, [[1, 2], [2, 2]]);
    assert.deepEqual(r.entries[1].vector, [1, 0], "reused vector kept as is");
    assert.equal(r.entries[0].textHash, textHash(spaceDocumentText(space, corpus[0])));
  });

  test("nothing to embed -> the embedder is never called (no model load, no key)", async () => {
    const a = opp("a");
    const f = fakeEmbedder();
    const r = await buildSpaceVectors(space, [a], { prior: priorFor([a]), embed: f.embed });
    assert.equal(f.calls.length, 0);
    assert.equal(r.entries.length, 1);
  });

  test("a stop between batches keeps what's finished and says it stopped", async () => {
    const f = fakeEmbedder();
    let batches = 0;
    const r = await buildSpaceVectors(space, [opp("a"), opp("b"), opp("c")], {
      embed: async (t: string[]) => {
        batches++;
        return f.embed(t);
      },
      batch: 1,
      shouldStop: () => batches >= 2,
    });
    assert.equal(r.stopped, true);
    assert.equal(r.entries.length, 2);
  });

  test("an embedder returning the wrong number of vectors fails loudly", async () => {
    await assert.rejects(
      () => buildSpaceVectors(space, [opp("a"), opp("b")], { embed: async () => [[1, 0]], batch: 2 }),
      /returned 1 vectors for 2 texts/,
    );
  });
});
