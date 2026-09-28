import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { loadAlertSnapshot, saveAlertSnapshot, normalizeAlertSnapshot } from "../store";

/**
 * D5 — localStorage persistence for the alert snapshot. Under node:test
 * there is no `window` global, so loadAlertSnapshot/saveAlertSnapshot
 * exercise the SSR/no-storage fallback path (never throws, degrades to
 * null/no-op) — same posture as lib/sidebar/__tests__/sidebarPrefs.test.ts
 * and lib/ui/__tests__/welcomeGuidePrefs.test.ts. normalizeAlertSnapshot is
 * exported specifically so the corrupt/malformed-value handling is directly
 * unit-testable without a DOM, mirroring sidebarPrefs.ts's
 * normalizeSidebarPrefs pattern.
 */
describe("loadAlertSnapshot / saveAlertSnapshot (no window)", () => {
  test("loadAlertSnapshot never throws and returns null without window", () => {
    assert.equal(loadAlertSnapshot(), null);
  });

  test("saveAlertSnapshot never throws without window (SSR no-op)", () => {
    assert.doesNotThrow(() =>
      saveAlertSnapshot({ profileKey: "p", savedAt: "2026-01-01T00:00:00.000Z", opportunities: {} }),
    );
  });
});

describe("normalizeAlertSnapshot", () => {
  test("returns null for absent/corrupt values", () => {
    assert.equal(normalizeAlertSnapshot(null), null);
    assert.equal(normalizeAlertSnapshot(undefined), null);
    assert.equal(normalizeAlertSnapshot("not an object"), null);
    assert.equal(normalizeAlertSnapshot(42), null);
    assert.equal(normalizeAlertSnapshot([]), null);
  });

  test("returns null when required top-level fields are missing or wrong type", () => {
    assert.equal(normalizeAlertSnapshot({}), null);
    assert.equal(normalizeAlertSnapshot({ profileKey: "p" }), null); // no savedAt/opportunities
    assert.equal(normalizeAlertSnapshot({ profileKey: "p", savedAt: 12345, opportunities: {} }), null);
    assert.equal(normalizeAlertSnapshot({ profileKey: "p", savedAt: "x", opportunities: "nope" }), null);
  });

  test("round-trips a well-formed snapshot unchanged", () => {
    const input = {
      profileKey: "p1",
      savedAt: "2026-01-01T00:00:00.000Z",
      opportunities: {
        "opp-1": { tier: "likely", closingSoon: true },
        "opp-2": { tier: "adjacent", closingSoon: false },
      },
    };
    assert.deepEqual(normalizeAlertSnapshot(input), input);
  });

  test("drops individual malformed opportunity entries instead of failing the whole snapshot", () => {
    const input = {
      profileKey: "p1",
      savedAt: "2026-01-01T00:00:00.000Z",
      opportunities: {
        "opp-good": { tier: "likely", closingSoon: false },
        "opp-bad-tier": { tier: "not-a-real-tier", closingSoon: false },
        "opp-not-object": "garbage",
        "opp-missing-tier": { closingSoon: true },
      },
    };
    const result = normalizeAlertSnapshot(input);
    assert.ok(result);
    assert.deepEqual(Object.keys(result!.opportunities), ["opp-good"]);
  });

  test("coerces a non-boolean closingSoon to false rather than throwing", () => {
    const input = {
      profileKey: "p1",
      savedAt: "2026-01-01T00:00:00.000Z",
      opportunities: { "opp-1": { tier: "verify", closingSoon: "yes" } },
    };
    const result = normalizeAlertSnapshot(input);
    assert.equal(result!.opportunities["opp-1"].closingSoon, false);
  });
});
