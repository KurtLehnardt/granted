import { test } from "node:test";
import assert from "node:assert/strict";

import { filterVerifiedRows, historyFromRows, dedupeByCompanyKeepingLargestVerified, type AwardRow } from "../match";

/**
 * A3-lite (awards provenance gate) — hermetic tests of the filter/compute
 * seam `historyFor()` (`lib/match.ts`) is built on. No network, no import of
 * the real `data/awards.json`: a small fixture row set stands in for it, with
 * a deliberate mix of verified (real `sourceUrl`) and unverified (no
 * `sourceUrl`, or an empty one) rows. This is what proves an unverifiable
 * company can never reach the UI, independent of whatever the live data file
 * currently contains.
 */

const verifiedA: AwardRow = {
  company: "VERIFIED COMPANY A",
  program: "SBIR",
  agency: "Department of Defense",
  amount: 500_000,
  year: 2023,
  state: "Utah",
  sameVertical: true,
  sourceUrl: "https://www.sbir.gov/awards?firm=VERIFIED%20COMPANY%20A",
};

const verifiedB: AwardRow = {
  company: "VERIFIED COMPANY B",
  program: "STTR",
  agency: "Department of Energy",
  amount: 300_000,
  year: 2022,
  state: "California",
  sameVertical: false,
  sourceUrl: "https://www.sbir.gov/awards?firm=VERIFIED%20COMPANY%20B",
};

// Never matched to a real CSV record — must never appear anywhere in output.
const unverifiedNoUrl: AwardRow = {
  company: "UNVERIFIED COMPANY NO URL",
  program: "SBIR",
  agency: "Department of Defense",
  amount: 999_999_999, // implausibly large — the kind of row provenance-gating exists to catch
  year: 2023,
  state: "Utah",
  sameVertical: true,
};

// Carries an empty-string sourceUrl — must be treated the same as "no url".
const unverifiedEmptyUrl: AwardRow = {
  company: "UNVERIFIED COMPANY EMPTY URL",
  program: "SBIR",
  agency: "Department of Defense",
  amount: 250_000,
  year: 2023,
  state: "Utah",
  sameVertical: true,
  sourceUrl: "",
};

test("filterVerifiedRows — keeps only rows with a non-empty sourceUrl", () => {
  const rows = [verifiedA, unverifiedNoUrl, verifiedB, unverifiedEmptyUrl];
  const kept = filterVerifiedRows(rows);

  assert.deepEqual(
    kept.map((r) => r.company).sort(),
    ["VERIFIED COMPANY A", "VERIFIED COMPANY B"],
  );
  assert.ok(kept.every((r) => typeof r.sourceUrl === "string" && r.sourceUrl.length > 0));
});

test("historyFromRows — unverified rows never appear in recipients", () => {
  const rows = [verifiedA, unverifiedNoUrl, unverifiedEmptyUrl, verifiedB];
  const history = historyFromRows(rows, "Utah");

  assert.ok(history, "expected a history object — at least one row is verified");
  const companies = history!.recipients.map((r) => r.company);
  assert.ok(!companies.includes("UNVERIFIED COMPANY NO URL"));
  assert.ok(!companies.includes("UNVERIFIED COMPANY EMPTY URL"));
  assert.deepEqual(companies.sort(), ["VERIFIED COMPANY A", "VERIFIED COMPANY B"]);

  // Every rendered recipient carries a real sourceUrl.
  assert.ok(history!.recipients.every((r) => typeof r.sourceUrl === "string" && r.sourceUrl.length > 0));
});

test("historyFromRows — counts/totals/median reflect ONLY verified rows", () => {
  const rows = [verifiedA, unverifiedNoUrl, unverifiedEmptyUrl, verifiedB];
  const history = historyFromRows(rows, "Utah");

  assert.ok(history);
  // Only 2 verified rows, not 4 — the unverified rows (one with an
  // implausibly huge amount) must not inflate the count or the total.
  assert.equal(history!.similarCompanies, 2);
  assert.equal(history!.totalAwarded, 500_000 + 300_000);
  assert.equal(history!.medianAward, Math.round((500_000 + 300_000) / 2));
  // inState: only verifiedA is Utah among the verified rows (unverified Utah
  // rows must not count even though their `state` field matches).
  assert.equal(history!.inState, 1);
  // inVertical: only verifiedA has sameVertical true among verified rows.
  assert.equal(history!.inVertical, 1);
});

test("historyFromRows — state abbreviation matches the same as the full name", () => {
  const rows = [verifiedA, unverifiedNoUrl, unverifiedEmptyUrl, verifiedB];
  const byAbbrev = historyFromRows(rows, "UT");
  const byFullName = historyFromRows(rows, "Utah");
  assert.equal(byAbbrev!.inState, byFullName!.inState);
  assert.equal(byAbbrev!.inState, 1);
});

test("historyFromRows — realistic free-text location ('Draper, UT 84020') matches too", () => {
  const rows = [verifiedA, unverifiedNoUrl, unverifiedEmptyUrl, verifiedB];
  const history = historyFromRows(rows, "Draper, UT 84020");
  assert.equal(history!.inState, 1);
});

test("historyFromRows — no state at all yields inState: 0, NOT a Utah default", () => {
  // This is the key regression test: historyFromRows must never assume
  // Utah when the caller has no location at all, even though this fixture
  // set contains real Utah rows that would wrongly count under the old
  // hardcoded `state ?? "utah"` fallback.
  const rows = [verifiedA, unverifiedNoUrl, unverifiedEmptyUrl, verifiedB];
  const history = historyFromRows(rows);
  assert.equal(history!.inState, 0);
  assert.ok(!("inStateLabel" in history!), "no resolvable state means no inStateLabel at all");
});

test("historyFromRows — inStateLabel reflects the normalized state when resolvable", () => {
  const history = historyFromRows([verifiedA], "UT");
  assert.equal(history!.inStateLabel, "Utah");
});

test("historyFromRows — an opportunity with ONLY unverified rows returns undefined (no history section at all)", () => {
  const rows = [unverifiedNoUrl, unverifiedEmptyUrl];
  const history = historyFromRows(rows);
  assert.equal(history, undefined);
});

test("historyFromRows — empty row array returns undefined", () => {
  assert.equal(historyFromRows([]), undefined);
});

test("historyFromRows — fromAgency=false (default) omits the fromAgency field entirely", () => {
  const history = historyFromRows([verifiedA], "Utah");
  assert.ok(history);
  assert.ok(!("fromAgency" in history!), "direct-match history must not carry fromAgency at all, not even false");
});

test("historyFromRows — fromAgency=true sets fromAgency:true and sorts recipients by award size", () => {
  // Order deliberately NOT amount-descending in the input — fromAgency mode
  // has no per-opportunity relevance ranking to preserve, so it sorts by
  // amount instead (the most notable real awards are the most useful thing
  // to show when these companies aren't specifically tied to this program).
  const rows = [verifiedB, verifiedA]; // B=$300k, A=$500k
  const history = historyFromRows(rows, "Utah", true);
  assert.ok(history);
  assert.equal(history!.fromAgency, true);
  assert.deepEqual(
    history!.recipients.map((r) => r.company),
    ["VERIFIED COMPANY A", "VERIFIED COMPANY B"], // A ($500k) before B ($300k)
  );
});

// ---------------------------------------------------------------------------
// dedupeByCompanyKeepingLargestVerified — the historyForAgency reduction step
// ---------------------------------------------------------------------------

test("dedupeByCompanyKeepingLargestVerified — a larger-amount UNVERIFIED row never bumps a smaller but real, verified row for the same company", () => {
  // The exact scenario a code review caught: without filtering to verified
  // rows FIRST, the naive "keep whichever amount is larger" reduction would
  // let this implausibly-large unverified row win the per-company slot,
  // silently dropping the real, sourceUrl-verified $500k row entirely (it
  // never reaches historyFromRows's own filterVerifiedRows call at all, since
  // only ONE row per company survives this reduction).
  const unverifiedButHuge: AwardRow = {
    company: "VERIFIED COMPANY A", // same company as the fixture `verifiedA`
    program: "SBIR",
    agency: "Department of Defense",
    amount: 999_999_999,
    year: 2023,
  };
  const deduped = dedupeByCompanyKeepingLargestVerified([unverifiedButHuge, verifiedA]);
  assert.equal(deduped.length, 1);
  assert.equal(deduped[0]!.amount, 500_000, "must keep the real $500k verified row, not the fabricated-looking $1B one");
  assert.equal(deduped[0]!.sourceUrl, verifiedA.sourceUrl);
});

test("dedupeByCompanyKeepingLargestVerified — among two verified rows for the same company, keeps the larger amount", () => {
  const biggerVerified: AwardRow = { ...verifiedA, amount: 750_000, year: 2024 };
  const deduped = dedupeByCompanyKeepingLargestVerified([verifiedA, biggerVerified]);
  assert.equal(deduped.length, 1);
  assert.equal(deduped[0]!.amount, 750_000);
});

test("dedupeByCompanyKeepingLargestVerified — an unverified-only company is dropped entirely, not just deduped away", () => {
  const deduped = dedupeByCompanyKeepingLargestVerified([unverifiedNoUrl, unverifiedEmptyUrl]);
  assert.deepEqual(deduped, []);
});
