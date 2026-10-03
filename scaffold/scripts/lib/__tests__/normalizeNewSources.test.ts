import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeSamRow, normalizeCaRow, normalizeIlRow, normalizeNcRow } from "../normalizeNewSources.mjs";
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

test("normalizeCaRow — 'Between $A and $B' range funding uses the CEILING, not the floor", () => {
  // Real bug found live: California's EstAmounts often reads "Between $A and
  // $B" (A is the floor, B the ceiling). Taking only the first dollar figure
  // in the text silently returns the floor as if it were the ceiling --
  // confirmed live, 3 real programs collapsed to a literal fundingHigh of $1.
  const row = {
    PortalID: "141033",
    Title: "Beet Curly Top Virus Control Program Grants",
    AgencyDept: "Department of Food and Agriculture",
    Purpose: "Funds control of the beet curly top virus across affected growing regions statewide.",
    EstAmounts: "Between $1.00 and $190,000.00",
  };
  const o = normalizeCaRow(row);
  assert.ok(o);
  assert.equal(o!.fundingHigh, 190_000, "ceiling must be the larger figure, not the first one found");
  assert.equal(o!.fundingLow, 1);
});

test("normalizeCaRow — EstAvailFunds (a single total, not a range) is used wholesale, never mixed with EstAmounts", () => {
  const row = {
    PortalID: "190509",
    Title: "Urban Streams Restoration Program",
    AgencyDept: "Department of Water Resources",
    Purpose: "Restores urban streams across California communities statewide every year.",
    EstAvailFunds: "$3,000,000.00",
    EstAmounts: "Between $1.00 and $190,000.00", // must be ignored -- EstAvailFunds has a real figure
  };
  const o = normalizeCaRow(row);
  assert.ok(o);
  assert.equal(o!.fundingHigh, 3_000_000);
  assert.equal(o!.fundingLow, undefined, "a single total is not a range -- no fundingLow");
});

test("normalizeCaRow — deadline requires an explicit YYYY-MM-DD shape, not just any 4-digit substring", () => {
  // Tightened per review: a bare "any 4-digit token + Date() doesn't throw"
  // check would wrongly accept non-date text like "FY 2027" or "Round 2027"
  // and fabricate a Jan-1 deadline via JS Date's permissive parsing.
  const base = {
    PortalID: "1",
    Title: "Some Program With A Reasonably Long Enough Title For This Test",
    AgencyDept: "Dept",
    Purpose: "Purpose text that is long enough to clear the description floor easily here.",
  };
  assert.equal(normalizeCaRow({ ...base, ApplicationDeadline: "FY 2027" })!.deadline, undefined);
  assert.equal(normalizeCaRow({ ...base, ApplicationDeadline: "Round 2027" })!.deadline, undefined);
  assert.equal(normalizeCaRow({ ...base, ApplicationDeadline: "2027" })!.deadline, undefined);
  assert.equal(normalizeCaRow({ ...base, ApplicationDeadline: "2026-11-02 17:00:00" })!.deadline, "2026-11-02 17:00:00");
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

test("normalizeIlRow — blank title returns null", () => {
  assert.equal(normalizeIlRow({ title: "" }), null);
});

test("normalizeIlRow — real fixture maps correctly (open-ended date, real award range)", () => {
  const row = {
    title: "APS_Spring 2025 Semester Pathways Program",
    url: "https://il.amplifund.com/Public/Opportunities/Details/0f9fad21-8730-4308-9a6e-d2b062587e1b",
    agency: "AGE (402)",
    dateRange: "04/03/2025 - No end date",
    awardRange: "$15000 - $75000",
  };
  const o = normalizeIlRow(row);
  assert.ok(o);
  assert.equal(o!.source, "il-grants");
  assert.equal(o!.geography, "Illinois");
  assert.equal(o!.deadline, undefined, "'No end date' must not become a fabricated deadline");
  assert.equal(o!.fundingLow, 15_000);
  assert.equal(o!.fundingHigh, 75_000);
  assert.ok(o!.description.length >= 60);
});

test("normalizeIlRow — a real close date is used as the deadline", () => {
  const row = {
    title: "93.324 - State Health Insurance Assistance Program (SHIP) Base Grant Year 2",
    url: "https://il.amplifund.com/Public/Opportunities/Details/776d2338-6519-4ecb-a7a1-9b3618158966",
    agency: "AGE (402)",
    dateRange: "09/22/2026 - 10/22/2026",
    awardRange: "$0 - $0",
  };
  const o = normalizeIlRow(row);
  assert.ok(o);
  assert.equal(o!.deadline, "10/22/2026");
  assert.equal(o!.fundingLow, undefined, "$0-$0 is not a real figure, must not be reported as free funding");
  assert.equal(o!.fundingHigh, undefined);
});

test("normalizeIlRow — 'Not Applicable' award range never fabricates a figure", () => {
  const row = {
    title: "Targeted Holistic Resources to Invest in Vision, Empowerment, and Success (THRIVES) Grants",
    url: "https://omb.illinois.gov/public/gata/csfa/Opportunity.aspx?nofo=4339",
    agency: "BHE (601)",
    dateRange: "08/31/2026 - 10/19/2026",
    awardRange: "Not Applicable",
  };
  const o = normalizeIlRow(row);
  assert.ok(o);
  assert.equal(o!.fundingLow, undefined);
  assert.equal(o!.fundingHigh, undefined);
  assert.equal(o!.deadline, "10/19/2026");
});

test("normalizeNcRow — blank title returns null", () => {
  assert.equal(normalizeNcRow({ title: "" }), null);
});

test("normalizeNcRow — real fixture maps correctly; no deadline/funding/eligibility (honest data ceiling)", () => {
  const row = {
    category: "Agriculture",
    url: "https://www.ncadfp.org/",
    title: "Agricultural Development and Farmland Preservation Trust Fund",
    agency: "AGR",
    description: "This program supports the farming, forestry, and horticulture communities within the agriculture industry.",
  };
  const o = normalizeNcRow(row);
  assert.ok(o);
  assert.equal(o!.source, "nc-grants");
  assert.equal(o!.geography, "North Carolina");
  assert.equal(o!.deadline, undefined, "NC's index has no deadline field at all -- must never be fabricated");
  assert.equal(o!.fundingLow, undefined);
  assert.equal(o!.fundingHigh, undefined);
  assert.equal(o!.eligibility, undefined);
  assert.deepEqual(o!.industryTags, ["Agriculture"]);
  assert.ok(o!.description.length >= 60);
});

test("normalizeNcRow — HTML entities in real scraped text are decoded (&amp; -> &)", () => {
  // Real value seen live: category "Art &amp; Culture".
  const row = {
    category: "Art &amp; Culture",
    url: "https://www.ncarts.org/grants-resources/grants-dashboard",
    title: "NC Arts Council Grants",
    agency: "DNCR",
    description: "The NC Arts Council provides grants to artists and organizations across the state every single year.",
  };
  const o = normalizeNcRow(row);
  assert.ok(o);
  assert.deepEqual(o!.industryTags, ["Art & Culture"]);
});
