import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { parseBuiltAt, corpusAsOf } from "../meta";

/**
 * Data-freshness: the corpus "as of" stamp. Pure/hermetic (node:test + assert,
 * no network, no DOM) — mirrors lib/ui/__tests__/opportunitySummary.test.ts.
 */

describe("parseBuiltAt", () => {
  test("formats a valid ISO instant as a UTC 'Month D, YYYY' label", () => {
    const result = parseBuiltAt({ builtAt: "2026-08-15T00:00:00.000Z" });
    assert.equal(result?.label, "August 15, 2026");
    assert.equal(result?.iso, "2026-08-15T00:00:00.000Z");
  });

  test("label is timezone-stable: formatted in UTC regardless of the machine zone", () => {
    // A late-evening UTC instant still reads as that same UTC calendar day —
    // it must never shift a day based on the runner's local timezone.
    assert.equal(parseBuiltAt({ builtAt: "2026-08-15T23:30:00.000Z" })?.label, "August 15, 2026");
    // A full-precision instant like the pipeline writes (new Date().toISOString()).
    assert.equal(parseBuiltAt({ builtAt: "2026-12-01T09:15:42.123Z" })?.label, "December 1, 2026");
  });

  test("null (safe fallback) when the meta object is absent", () => {
    assert.equal(parseBuiltAt(null), null);
    assert.equal(parseBuiltAt(undefined), null);
  });

  test("null when builtAt is missing", () => {
    assert.equal(parseBuiltAt({}), null);
  });

  test("null when builtAt is not a string", () => {
    assert.equal(parseBuiltAt({ builtAt: 1_699_999_999 }), null);
    assert.equal(parseBuiltAt({ builtAt: "" }), null);
    assert.equal(parseBuiltAt({ builtAt: "   " }), null);
  });

  test("null for an unparseable / Invalid-Date value (never fabricate a date)", () => {
    assert.equal(parseBuiltAt({ builtAt: "not-a-date" }), null);
    assert.equal(parseBuiltAt({ builtAt: "2026-13-45" }), null);
  });
});

describe("corpusAsOf (the committed data/corpus-meta.json)", () => {
  test("surfaces a valid, non-null as-of for the shipped corpus", () => {
    const result = corpusAsOf();
    assert.ok(result, "the committed corpus-meta.json should parse to an as-of surface");
    // A human, date-shaped label (e.g. "August 15, 2026").
    assert.match(result!.label, /^[A-Z][a-z]+ \d{1,2}, \d{4}$/);
    // A valid ISO instant round-trips.
    assert.equal(Number.isNaN(Date.parse(result!.iso)), false);
  });
});
