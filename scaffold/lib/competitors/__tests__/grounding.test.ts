import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { groundSynthesis } from "../analyze";

/**
 * R5-deep — the LIVE pipeline's anti-fabrication guarantee.
 *
 * `groundSynthesis` — the pure, defense-in-depth filter that drops any
 * model-invented id BEFORE the schema parse (so a stray hallucination degrades
 * to fewer honest claims, never a fabricated one on screen).
 */

describe("groundSynthesis — drops everything the model invented", () => {
  const records = [{ id: "usa_1" }, { id: "nih_2" }];
  const webProfiles = [{ id: "web_1" }];

  const synthesis = {
    competitors: [
      { recordId: "usa_1", positioning: "kept", quotedSnippet: "q" }, // valid award → kept
      { recordId: "ghost_9", positioning: "p", quotedSnippet: "q" }, // not retrieved → dropped
      { recordId: "web_1", positioning: "p", quotedSnippet: "q" }, // web id not allowed as a card → dropped
      { recordId: "usa_1", positioning: "", quotedSnippet: "q" }, // empty positioning → dropped
    ],
    recommendations: [
      { advice: "a", citations: ["usa_1", "web_1", "ghost_9"] }, // kept; ghost stripped
      { advice: "b", citations: ["ghost_1", "ghost_2"] }, // no valid citation → dropped
      { advice: "", citations: ["usa_1"] }, // no advice → dropped
    ],
    opportunities: [
      { advice: "o", citations: ["web_1"] }, // web citation allowed → kept
      { advice: "o2", citations: [] }, // no citation → dropped
    ],
  };

  const grounded = groundSynthesis({ records, webProfiles, synthesis });

  test("keeps only competitors backed by a real award record", () => {
    assert.equal(grounded.competitors.length, 1);
    assert.equal(grounded.competitors[0].recordId, "usa_1");
  });

  test("a web-profile id can never back a competitor card", () => {
    assert.ok(!grounded.competitors.some((c) => c.recordId === "web_1"));
  });

  test("strips invented citation ids but keeps the grounded ones", () => {
    assert.equal(grounded.recommendations.length, 1);
    assert.deepEqual(grounded.recommendations[0].citations, ["usa_1", "web_1"]);
  });

  test("drops any recommendation/opportunity left with no real citation", () => {
    assert.ok(!grounded.recommendations.some((r) => r.advice === "b"));
    assert.equal(grounded.opportunities.length, 1);
    assert.deepEqual(grounded.opportunities[0].citations, ["web_1"]);
  });
});
