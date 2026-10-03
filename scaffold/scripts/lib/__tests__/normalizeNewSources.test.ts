import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeSamRow, normalizeCaRow } from "../normalizeNewSources.mjs";
import { normalizeStateName } from "../../../lib/location";

test("normalizeSamRow — blank title returns null", () => {
  assert.equal(normalizeSamRow({ title: "   " }), null);
});

test("normalizeSamRow — real fixture maps correctly", () => {
  const row = {
    programNumber: "10.001",
    title: "Example Assistance Program",
    agency: "Department of Example",
    objectives: "Helps examples happen.",
    uses: "Funds can be used for example purposes.",
    eligibility: "States and local governments.",
    url: "https://example.gov/program",
    kind: "assistance",
    _keywords: ["technology"],
  };
  const o = normalizeSamRow(row);
  assert.ok(o);
  assert.equal(o!.id, "sam-10.001");
  assert.equal(o!.source, "assistance-listings");
  assert.equal(o!.kind, "assistance");
  assert.ok(o!.description.length >= 60, "description must clear the 60-char corpus floor");
  assert.equal(o!.status, "continuous");
});

test("normalizeCaRow — blank title returns null", () => {
  assert.equal(normalizeCaRow({ Title: "" }), null);
});

test("normalizeCaRow — real-shaped fixture maps correctly, PortalID not GrantID", () => {
  const row = {
    PortalID: "191046",
    GrantID: null,
    Status: "active",
    Title: "The Recreational Trails Program (RTP) – R27",
    Type: "Grant",
    AgencyDept: "Department of Parks and Recreation",
    Purpose: "The purpose of the Recreational Trails Program is to provide for well managed OHV Recreation.",
    Description: "The Recreational Trails Program (RTP) provides funds to develop and maintain Recreational Trails.",
    ApplicantType: "Nonprofit; Public Agency",
    ApplicantTypeNotes: "Cities, counties, districts, state and federal agencies, and 501(c)(3) nonprofit organizations.",
    EstAmounts: "Dependant on number of submissions received, application process, etc.",
    EstAvailFunds: "$3,000,000.00",
    ApplicationDeadline: "2026-11-02 17:00:00",
    GrantURL: "https://www.grants.ca.gov/grants/the-recreational-trails-program-rtp-r27/",
  };
  const o = normalizeCaRow(row);
  assert.ok(o);
  assert.equal(o!.id, "ca-191046", "must use PortalID, not GrantID");
  assert.equal(o!.source, "ca-grants");
  assert.equal(o!.kind, "grant");
  assert.ok(o!.description.length >= 60, "description must clear the 60-char corpus floor");
  assert.equal(o!.fundingHigh, 3_000_000, "must parse EstAvailFunds, not the prose EstAmounts");
  assert.equal(o!.deadline, "2026-11-02 17:00:00");
  assert.equal(o!.geography, "California");
  assert.equal(normalizeStateName(o!.geography), "California", "geography must round-trip through the state normalizer");
});

test("normalizeCaRow — GrantID garbage (agency name, not an id) is never used as the key", () => {
  const row = {
    PortalID: "190509",
    GrantID: "Department of Water Resources", // confirmed real garbage value seen live
    Status: "active",
    Title: "Urban Streams Restoration Program",
    AgencyDept: "Department of Water Resources",
    Purpose: "Restores urban streams.",
    Description: "Funds urban stream restoration projects statewide.",
  };
  const o = normalizeCaRow(row);
  assert.ok(o);
  assert.equal(o!.id, "ca-190509");
});

test("normalizeCaRow — 'Ongoing' deadline becomes undefined, not a literal non-date string", () => {
  const row = {
    PortalID: "190509",
    Title: "Urban Streams Restoration Program",
    AgencyDept: "Department of Water Resources",
    Purpose: "Restores urban streams.",
    Description: "Funds urban stream restoration projects statewide across California communities.",
    ApplicationDeadline: "Ongoing",
  };
  const o = normalizeCaRow(row);
  assert.ok(o);
  assert.equal(o!.deadline, undefined);
});

test("normalizeCaRow — missing deadline/funding never fabricates a value", () => {
  const row = {
    PortalID: "192057",
    Title: "A Forecasted Grant With No Dates Yet",
    AgencyDept: "Some Department",
    Purpose: "A program that has not opened yet.",
    Description: "This program is forecasted and details are not yet finalized for applicants.",
    EstAmounts: "Dependant on number of submissions received, application process, etc.",
  };
  const o = normalizeCaRow(row);
  assert.ok(o);
  assert.equal(o!.deadline, undefined);
  assert.equal(o!.fundingHigh, undefined);
});

test("normalizeCaRow — Loan type maps to kind:loan, everything else to kind:grant", () => {
  const base = {
    PortalID: "1",
    Title: "Some Program With A Reasonably Long Enough Title For This Test",
    AgencyDept: "Dept",
    Purpose: "Purpose text that is long enough to clear the description floor easily here.",
  };
  assert.equal(normalizeCaRow({ ...base, Type: "Loan" })!.kind, "loan");
  assert.equal(normalizeCaRow({ ...base, Type: "Grant" })!.kind, "grant");
  assert.equal(normalizeCaRow({ ...base, Type: "Grant; Loan" })!.kind, "grant");
});
