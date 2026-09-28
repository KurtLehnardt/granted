import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { summarizeDescription } from "../formSummary";

describe("summarizeDescription", () => {
  test("returns short text untouched", () => {
    assert.equal(summarizeDescription("AI diagnostics for rural clinics"), "AI diagnostics for rural clinics");
  });

  test("collapses internal newlines and repeated whitespace to single spaces", () => {
    assert.equal(
      summarizeDescription("We build AI\n\ndiagnostics   for   rural clinics."),
      "We build AI diagnostics for rural clinics.",
    );
  });

  test("trims leading and trailing whitespace", () => {
    assert.equal(summarizeDescription("   padded text   "), "padded text");
  });

  test("truncates long text and appends a single ellipsis character", () => {
    const long = "a".repeat(200);
    const out = summarizeDescription(long, 140);
    assert.equal(out.length, 141);
    assert.ok(out.endsWith("…"));
    assert.equal(out.slice(0, 140), "a".repeat(140));
  });

  test("text exactly at maxLen is not truncated", () => {
    const exact = "b".repeat(140);
    assert.equal(summarizeDescription(exact, 140), exact);
  });

  test("empty input returns empty string", () => {
    assert.equal(summarizeDescription(""), "");
    assert.equal(summarizeDescription("   \n  "), "");
  });

  test("respects a custom maxLen", () => {
    assert.equal(summarizeDescription("hello world", 5), "hello…");
  });
});
