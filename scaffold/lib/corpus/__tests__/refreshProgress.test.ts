import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { overallPct, stageFraction, stageLabel, STAGE_WEIGHTS } from "../refreshProgress";

describe("STAGE_WEIGHTS", () => {
  test("sums to 100", () => {
    const total = Object.values(STAGE_WEIGHTS).reduce((a, b) => a + b, 0);
    assert.equal(total, 100);
  });
});

describe("stageFraction", () => {
  test("0 when total is unknown or zero", () => {
    assert.equal(stageFraction(5, undefined), 0);
    assert.equal(stageFraction(5, 0), 0);
  });
  test("done/total, clamped to [0,1]", () => {
    assert.equal(stageFraction(5, 10), 0.5);
    assert.equal(stageFraction(20, 10), 1);
    assert.equal(stageFraction(-5, 10), 0);
  });
});

describe("overallPct", () => {
  test("the first stage starts at 0", () => {
    assert.equal(overallPct("grants.gov search"), 0);
  });
  test("a stage with no done/total reads as fully-before-it", () => {
    assert.equal(overallPct("sam.gov"), STAGE_WEIGHTS["grants.gov search"] + STAGE_WEIGHTS["grants.gov details"]);
  });
  test("halfway through embedding lands between embedding's start and end", () => {
    const before = 5 + 25 + 10 + 10 + 10 + 5; // everything before embedding
    const pct = overallPct("embedding", 50, 100);
    assert.equal(pct, before + STAGE_WEIGHTS.embedding / 2);
  });
  test("the last stage complete reads 100", () => {
    assert.equal(overallPct("saving", 1, 1), 100);
  });
  test("never exceeds 100 or goes below 0", () => {
    assert.equal(overallPct("saving", 999, 1), 100);
  });
});

describe("stageLabel", () => {
  test("embedding shows done of total new", () => {
    assert.equal(stageLabel("embedding", 120, 340), "Embedding 120 of 340 new");
  });
  test("embedding with no total falls back to the base label", () => {
    assert.equal(stageLabel("embedding"), "Embedding");
  });
  test("another stage with done/total shows a parenthetical", () => {
    assert.equal(stageLabel("grants.gov details", 200, 800), "Fetching grants.gov details (200 of 800)");
  });
  test("a stage with no done/total shows just the base label", () => {
    assert.equal(stageLabel("sam.gov"), "Fetching SAM.gov");
  });
});
