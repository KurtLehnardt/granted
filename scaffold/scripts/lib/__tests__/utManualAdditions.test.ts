import { test } from "node:test";
import assert from "node:assert/strict";
import { MANUAL_ADDITIONS } from "../utManualAdditions.mjs";
import { normalizeUtRow } from "../normalizeNewSources.mjs";

// MANUAL_ADDITIONS is a plain data module (no Playwright import, no
// top-level await) specifically so this test can import it without
// launching a browser -- 1-fetch-ut-grants.mjs itself can't be imported for
// this, since it runs its real scrape unconditionally on import.

test("MANUAL_ADDITIONS has no duplicate titles", () => {
  const titles = MANUAL_ADDITIONS.map((r) => r.title);
  assert.equal(new Set(titles).size, titles.length);
});

test("MANUAL_ADDITIONS covers exactly the 7 confirmed-missing GOEO programs", () => {
  const titles = MANUAL_ADDITIONS.map((r) => r.title).sort();
  assert.deepEqual(titles, [
    "Affordable Housing Infrastructure Grant",
    "First Home Investment Zone (FHIZ)",
    "Hotel Impact Mitigation Fund",
    "Housing and Transit Reinvestment Zone (HTRZ)",
    "Major Sporting Event Venue Zone (MSEVZ)",
    "Regionally Significant Development Zone (RSDZ)",
    "Utah Innovation Fund",
  ]);
});

test("every MANUAL_ADDITIONS row has a real https:// url and a non-empty agency", () => {
  for (const row of MANUAL_ADDITIONS) {
    assert.match(row.url, /^https:\/\//, `${row.title} url`);
    assert.ok(row.agency.length > 0, `${row.title} agency`);
  }
});

test("every MANUAL_ADDITIONS row normalizes to a valid opportunity via the same pipeline as scraped rows", () => {
  const ids = new Set<string>();
  for (const row of MANUAL_ADDITIONS) {
    const o = normalizeUtRow(row);
    assert.ok(o, `${row.title} normalized to null`);
    assert.equal(o!.source, "ut-grants");
    assert.equal(o!.geography, "Utah");
    assert.equal(o!.program, row.title);
    assert.equal(o!.url, row.url);
    assert.ok(o!.description.length >= 60, `${row.title} description must clear the 60-char corpus floor`);
    assert.ok(!ids.has(o!.id), `${row.title} id collided with another addition`);
    ids.add(o!.id);
  }
});

test("Hotel Impact Mitigation Fund is classified as a grant with its $2.1M pool as fundingHigh, not a loan", () => {
  const row = MANUAL_ADDITIONS.find((r) => r.title === "Hotel Impact Mitigation Fund")!;
  const o = normalizeUtRow(row)!;
  assert.equal(o.kind, "grant");
  assert.equal(o.fundingHigh, 2_100_000);
  assert.equal(o.fundingLow, undefined);
});

test("the four zone tools (HTRZ/FHIZ/RSDZ/MSEVZ) have no dollar figure to parse -- they're tax-increment capture, not a fixed award", () => {
  for (const title of [
    "Housing and Transit Reinvestment Zone (HTRZ)",
    "First Home Investment Zone (FHIZ)",
    "Regionally Significant Development Zone (RSDZ)",
    "Major Sporting Event Venue Zone (MSEVZ)",
  ]) {
    const row = MANUAL_ADDITIONS.find((r) => r.title === title)!;
    const o = normalizeUtRow(row)!;
    assert.equal(o.fundingHigh, undefined, title);
    assert.equal(o.fundingLow, undefined, title);
  }
});

test("Utah Innovation Fund's description says it is equity, not a grant, even though kind defaults to grant", () => {
  const row = MANUAL_ADDITIONS.find((r) => r.title === "Utah Innovation Fund")!;
  const o = normalizeUtRow(row)!;
  assert.match(o.description, /equity/i);
  assert.equal(o.kind, "grant"); // no equity/investment Kind exists in OpportunityKindSchema; grant is the closest default
});
