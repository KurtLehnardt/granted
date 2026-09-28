import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { scoreDescription, countWords } from "../descriptionStrength";
import { TEST_CASES } from "../testCases";

/**
 * The meter scores LENGTH, by product decision (see the module header for what
 * that trades away). These tests pin the thresholds against real descriptions
 * rather than invented strings, so a future change to the numbers has to face
 * what it does to the app's own worked examples.
 */

const SHORT = "vertical farm using llm for crop growth and serving food deserts"; // 11 words

const PARAGRAPH =
  "We operate indoor vertical farms in converted warehouses, using machine learning " +
  "models to optimise crop growth cycles, lighting and nutrient dosing for leafy greens. " +
  "We are a 9-person Colorado company distributing produce into USDA-designated food " +
  "deserts, and we are seeking funding to expand growing capacity and run a " +
  "nutrition-outcomes study with a local health department. We would use the award to " +
  "add two growing rooms, hire a plant scientist, and measure nutrition outcomes with " +
  "a partner clinic over an eighteen month period.";

describe("countWords", () => {
  test("splits on any run of whitespace and ignores padding", () => {
    assert.equal(countWords("one two three"), 3);
    assert.equal(countWords("  one\n\ttwo   three  "), 3);
    assert.equal(countWords(""), 0);
    assert.equal(countWords("   "), 0);
    assert.equal(countWords("single"), 1);
  });
});

describe("scoreDescription — bands track length", () => {
  test("a one-line description is weak", () => {
    const r = scoreDescription(SHORT);
    assert.equal(r.band, "weak");
    assert.equal(r.wordCount, 11);
    assert.ok(r.suggestions.some((s) => s.includes("paragraph or two")));
  });

  test("a paragraph or two is strong, and stops nagging", () => {
    const r = scoreDescription(PARAGRAPH);
    assert.equal(r.band, "strong");
    assert.deepEqual(r.suggestions, [], "a long enough description needs no advice");
  });

  test("longer always scores at least as high as shorter", () => {
    let prev = -1;
    for (const n of [1, 5, 19, 20, 40, 59, 60, 120, 400]) {
      const { score } = scoreDescription("word ".repeat(n));
      assert.ok(score >= prev, `score went down at ${n} words (${score} < ${prev})`);
      prev = score;
    }
  });

  test("the score saturates rather than exceeding 100", () => {
    assert.equal(scoreDescription("word ".repeat(1000)).score, 100);
  });

  test("empty input is weak, scores 0, and asks for the basics", () => {
    for (const empty of ["", "   ", null, undefined]) {
      const r = scoreDescription(empty);
      assert.equal(r.score, 0);
      assert.equal(r.band, "weak");
      assert.equal(r.wordCount, 0);
      assert.equal(r.suggestions.length, 1);
    }
  });

  test("stays in range and in band for hostile input", () => {
    for (const i of ["a", "🌱🌱🌱", "\n\n\n", "word ".repeat(5000)]) {
      const r = scoreDescription(i);
      assert.ok(r.score >= 0 && r.score <= 100, `${r.score} out of range`);
      assert.ok(["weak", "fair", "strong"].includes(r.band));
    }
  });
});

/**
 * CALIBRATION GUARD.
 *
 * lib/testCases.ts holds the four sample companies the app ships and replays
 * from the welcome guide. They are curated, each returns 33 matches, and they
 * are the closest thing the repo has to "a description that works".
 *
 * They run 26–38 words. A length threshold tuned without checking them would
 * happily grade the product's own worked examples as thin — an earlier
 * calibration of this meter did exactly that — so the thresholds are pinned
 * against the real text here rather than against numbers chosen in the abstract.
 */
describe("calibration against the shipped sample companies", () => {
  test("the fixture is present and looks like descriptions", () => {
    assert.ok(TEST_CASES.length >= 4, "expected the shipped sample companies");
    for (const tc of TEST_CASES) {
      assert.ok(tc.text.length > 150, `${tc.id}: not a real description`);
    }
  });

  test("no curated sample company reads as thin", () => {
    const thin = TEST_CASES.map((tc) => ({ id: tc.id, ...scoreDescription(tc.text) })).filter(
      (r) => r.band === "weak",
    );
    assert.deepEqual(
      thin.map((t) => `${t.id} (${t.wordCount} words)`),
      [],
      "the app's own worked examples must not be graded weak — that is the meter being wrong, not the samples",
    );
  });
});
