import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { reciprocalRankFusion, fuseRankings } from "../hybrid";

describe("reciprocalRankFusion", () => {
  test("an id present in both lists outranks one present in only one", () => {
    const scores = reciprocalRankFusion([
      ["a", "b", "c"],
      ["b", "a", "d"],
    ]);
    assert.ok(scores.get("b")! > scores.get("c")!);
    assert.ok(scores.get("a")! > scores.get("c")!);
  });

  test("a higher rank (earlier position) scores higher within one list", () => {
    const scores = reciprocalRankFusion([["a", "b", "c"]]);
    assert.ok(scores.get("a")! > scores.get("b")!);
    assert.ok(scores.get("b")! > scores.get("c")!);
  });
});

describe("fuseRankings", () => {
  test("a rare exact keyword hit promotes its doc above a higher-cosine-only doc", () => {
    // Cosine order: cosine-favorite first, keyword-match doc near the bottom.
    const cosineIds = ["cosine-favorite", "middle-1", "middle-2", "keyword-match"];
    // BM25 found ONE hit — an exact, rare keyword — and it's this doc.
    const bm25Ids = ["keyword-match"];

    const fused = fuseRankings(cosineIds, bm25Ids);
    const keywordRank = fused.indexOf("keyword-match");
    const cosineFavoriteRank = fused.indexOf("cosine-favorite");
    assert.ok(keywordRank < cosineFavoriteRank, "the exact-keyword doc must rank above the cosine-only favorite");
  });

  test("no BM25 signal at all preserves the exact original cosine order", () => {
    const cosineIds = ["a", "b", "c", "d"];
    assert.deepEqual(fuseRankings(cosineIds, []), cosineIds);
  });

  test("an id BM25 doesn't mention still appears, ranked by its cosine position", () => {
    const cosineIds = ["a", "b", "c"];
    const bm25Ids = ["c"];
    const fused = fuseRankings(cosineIds, bm25Ids);
    assert.deepEqual(fused.slice().sort(), cosineIds.slice().sort());
    assert.ok(fused.includes("a") && fused.includes("b"));
  });

  test("BM25 can never introduce an id absent from the cosine list", () => {
    const cosineIds = ["a", "b"];
    const bm25Ids = ["a", "ghost-not-in-cosine-list"];
    const fused = fuseRankings(cosineIds, bm25Ids);
    assert.deepEqual(fused.slice().sort(), ["a", "b"]);
  });
});
