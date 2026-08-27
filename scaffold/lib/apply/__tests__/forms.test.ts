import { test } from "node:test";
import assert from "node:assert/strict";

import {
  PrefilledFormsSchema,
  PrefilledFieldSchema,
  type PrefilledForms,
  type PrefilledField,
} from "../../contracts/applicationForms";
import { FOUNDER_TODO_PATTERN } from "../../contracts/applicationDraft";
import type { CompanyProfile } from "../../contracts/companyProfile";
import type { AutoFillRequirements } from "../../mockAuth";
import type { Opportunity } from "../../contracts/opportunity";
import { prefillApplicationForms } from "../forms";

/**
 * G3 tests — hermetic, NO network, STATIC fixtures only. `prefillApplicationForms`
 * is a PURE deterministic mapper (no model call), so every case runs offline and
 * exercises the honesty contract: grounded fields always name a `source`, gaps
 * are always the exact `[founder to provide: …]` placeholder, and nothing is ever
 * fabricated.
 */

/** A `user_stated` provenanced cell (mirrors G2's helper). */
function cell<T>(value: T) {
  return { value, provenance: "user_stated" as const, confidence: 1 };
}

/** The all-empty SAM/UEI settings (nothing on file). */
const EMPTY_REQS: AutoFillRequirements = {
  samRegistered: false,
  samRegisteredDate: "",
  uei: "",
  aorName: "",
  aorOnFile: false,
  eBizPocOnFile: false,
};

/** A representative matched opportunity. */
function sampleOpp(overrides: Partial<Opportunity> = {}): Opportunity {
  return {
    id: "grants-42",
    source: "grants.gov",
    kind: "grant",
    program: "Rural Health Technology Program",
    agency: "Department of Health and Human Services",
    description: "Funds rural clinical technology deployment.",
    source_id: "HHS-2025-RHT-001",
    title: "Rural Health Technology Program (FY25)",
    ...overrides,
  } as Opportunity;
}

/** Find a field by key within the (single) SF-424 form. */
function field(forms: PrefilledForms, key: string): PrefilledField | undefined {
  return forms.forms[0].fields.find((f) => f.key === key);
}

// ---------------------------------------------------------------------------
// Case 1 — a well-filled profile + SAM settings pre-fills grounded fields with
// the correct `source`.
// ---------------------------------------------------------------------------

function wellFilledProfile(): CompanyProfile {
  return {
    id: "p1",
    raw_text: cell("We build electrochemical biosensor arrays for rural clinics."),
    entity_type: cell("for_profit_small_business"),
    location: cell("Boise, Idaho"),
    naics_codes: cell(["541714", "621511"]),
    uei: cell("PROFILEUEI999"),
    sam_registered: cell(true),
    capital_requirement: cell("250k_1m"),
    interview_answers: [],
  } as CompanyProfile;
}

test("a well-filled profile + SAM settings grounds UEI/NAICS/entity_type/SAM status with correct source", () => {
  const reqs: AutoFillRequirements = {
    ...EMPTY_REQS,
    samRegistered: true,
    samRegisteredDate: "2025-01-15",
    uei: "SAMUEI1234567",
    aorName: "Dana Founder",
    aorOnFile: true,
  };
  const out = prefillApplicationForms(wellFilledProfile(), reqs, sampleOpp());

  // UEI — the SAM settings win over the profile self-report.
  const uei = field(out, "uei")!;
  assert.equal(uei.status, "prefilled");
  assert.equal(uei.value, "SAMUEI1234567");
  assert.equal(uei.source, "sam.uei");

  // NAICS — grounded from the profile array, joined.
  const naics = field(out, "naics_code")!;
  assert.equal(naics.status, "prefilled");
  assert.equal(naics.value, "541714, 621511");
  assert.equal(naics.source, "profile.naics_codes");

  // Entity type — grounded from the profile with a human label.
  const entity = field(out, "entity_type")!;
  assert.equal(entity.status, "prefilled");
  assert.equal(entity.source, "profile.entity_type");
  assert.match(entity.display, /small business/i);

  // SAM status — grounded from the SAM settings, with the date.
  const sam = field(out, "sam_registration_status")!;
  assert.equal(sam.status, "prefilled");
  assert.equal(sam.source, "sam.samRegistered");
  assert.match(sam.display, /Registered in SAM\.gov/);
  assert.match(sam.display, /2025-01-15/);

  // AOR name — grounded from the SAM settings.
  const aor = field(out, "authorized_representative_name")!;
  assert.equal(aor.status, "prefilled");
  assert.equal(aor.value, "Dana Founder");
  assert.equal(aor.source, "sam.aorName");

  // Opportunity identifiers — grounded from the Opportunity record.
  assert.equal(field(out, "awarding_agency")!.source, "opportunity.agency");
  assert.equal(field(out, "funding_opportunity_number")!.source, "opportunity.source_id");
  assert.equal(field(out, "funding_opportunity_title")!.source, "opportunity.title");

  // Coarse capital range — a NON-authoritative grounded hint, clearly a range.
  const range = field(out, "capital_requirement_range")!;
  assert.equal(range.status, "prefilled");
  assert.equal(range.source, "profile.capital_requirement");
  assert.equal(range.value, "$250K–$1M");

  // The coarse location is grounded; the structured street/city/state/zip stay gaps.
  const loc = field(out, "applicant_location")!;
  assert.equal(loc.status, "prefilled");
  assert.equal(loc.value, "Boise, Idaho");
  assert.equal(loc.source, "profile.location");
  for (const k of ["applicant_street", "applicant_city", "applicant_state", "applicant_zip"]) {
    assert.equal(field(out, k)!.status, "founder_to_provide");
  }
});

test("UEI falls back to the profile self-report when the SAM settings carry none", () => {
  const out = prefillApplicationForms(wellFilledProfile(), EMPTY_REQS, sampleOpp());
  const uei = field(out, "uei")!;
  assert.equal(uei.status, "prefilled");
  assert.equal(uei.value, "PROFILEUEI999");
  assert.equal(uei.source, "profile.uei");
});

// ---------------------------------------------------------------------------
// Case 2 — a sparse profile emits the right `[founder to provide: …]` GAPS, each
// matching FOUNDER_TODO_PATTERN.
// ---------------------------------------------------------------------------

function sparseProfile(): CompanyProfile {
  return {
    id: "p2",
    raw_text: cell("A small robotics startup."),
    interview_answers: [],
  } as CompanyProfile;
}

test("a sparse profile + empty SAM settings emits the expected honest gaps", () => {
  // Opportunity without a source_id → the opportunity number is also a gap.
  const out = prefillApplicationForms(sparseProfile(), EMPTY_REQS, sampleOpp({ source_id: undefined }));

  const expectedGapKeys = [
    "organization_name",
    "project_title",
    "uei",
    "entity_type",
    "naics_code",
    "authorized_representative_name",
    "applicant_location",
    "applicant_street",
    "applicant_city",
    "applicant_state",
    "applicant_zip",
    "applicant_congressional_district",
    "federal_funding_requested",
    "total_project_cost",
    "project_start_date",
    "project_end_date",
    "funding_opportunity_number",
  ];
  for (const key of expectedGapKeys) {
    const f = field(out, key)!;
    assert.equal(f.status, "founder_to_provide", `${key} should be a gap`);
    assert.match(f.display, FOUNDER_TODO_PATTERN, `${key} display must match FOUNDER_TODO_PATTERN`);
  }

  // The absent capital range is simply not emitted (never a manufactured gap).
  assert.equal(field(out, "capital_requirement_range"), undefined);

  // The derived `gaps` list is non-empty and EVERY entry matches the pattern.
  assert.ok(out.gaps.length > 0);
  for (const g of out.gaps) {
    assert.match(g, FOUNDER_TODO_PATTERN);
  }
  // Sanity: the headline applicant-specific blanks are present.
  assert.ok(out.gaps.includes("[founder to provide: organization legal name]"));
  assert.ok(out.gaps.includes("[founder to provide: project title]"));
  assert.ok(out.gaps.includes("[founder to provide: federal funding amount requested (exact dollar figure)]"));

  // SAM status is NEVER a gap — the settings always carry a concrete boolean.
  assert.equal(field(out, "sam_registration_status")!.status, "prefilled");
});

// ---------------------------------------------------------------------------
// Case 3 — NO field ever carries a fabricated value: prefilled ⇒ has a source,
// gap ⇒ no value, across both a rich and a sparse input.
// ---------------------------------------------------------------------------

test("no field is ever fabricated — prefilled always has a source; a gap never has a value", () => {
  const rich = prefillApplicationForms(wellFilledProfile(), { ...EMPTY_REQS, uei: "SAMUEI1234567" }, sampleOpp());
  const sparse = prefillApplicationForms(sparseProfile(), EMPTY_REQS, sampleOpp({ source_id: undefined }));

  for (const out of [rich, sparse]) {
    for (const f of out.forms.flatMap((form) => form.fields)) {
      if (f.status === "prefilled") {
        assert.ok(f.source && f.source.length > 0, `prefilled ${f.key} must name a source`);
        assert.ok(f.value && f.value.length > 0, `prefilled ${f.key} must carry a value`);
        assert.doesNotMatch(f.display, FOUNDER_TODO_PATTERN, `prefilled ${f.key} display must not be a placeholder`);
      } else {
        assert.equal(f.value, undefined, `gap ${f.key} must not carry a value`);
        assert.equal(f.source, undefined, `gap ${f.key} must not carry a source`);
        assert.match(f.display, FOUNDER_TODO_PATTERN, `gap ${f.key} display must be a placeholder`);
      }
    }
  }
});

// ---------------------------------------------------------------------------
// Case 4 — the schema accepts a real output and rejects a gap whose placeholder
// violates FOUNDER_TODO_PATTERN (and other honesty-contract violations).
// ---------------------------------------------------------------------------

test("PrefilledFormsSchema.parse accepts a real generated output", () => {
  const out = prefillApplicationForms(wellFilledProfile(), { ...EMPTY_REQS, uei: "SAMUEI1234567" }, sampleOpp());
  assert.doesNotThrow(() => PrefilledFormsSchema.parse(out));
});

test("the schema REJECTS a gap whose placeholder violates FOUNDER_TODO_PATTERN", () => {
  const badGap = { key: "project_title", label: "Project title", status: "founder_to_provide", display: "TODO: fill me in" };
  assert.equal(PrefilledFieldSchema.safeParse(badGap).success, false);
});

test("the schema REJECTS a prefilled field with no source (ungrounded value)", () => {
  const ungrounded = { key: "uei", label: "UEI", status: "prefilled", value: "SAMUEI1234567", display: "SAMUEI1234567" };
  assert.equal(PrefilledFieldSchema.safeParse(ungrounded).success, false);
});

test("the schema REJECTS a gap that smuggles in a value", () => {
  const smuggled = {
    key: "organization_name",
    label: "Organization legal name",
    status: "founder_to_provide",
    value: "Acme Robotics Inc.",
    display: "[founder to provide: organization legal name]",
  };
  assert.equal(PrefilledFieldSchema.safeParse(smuggled).success, false);
});

test("FOUNDER_TODO_PATTERN is reused from applicationDraft — same one convention across WS-G", () => {
  assert.match("[founder to provide: project title]", FOUNDER_TODO_PATTERN);
  assert.doesNotMatch("[founder to provide:]", FOUNDER_TODO_PATTERN);
  assert.doesNotMatch("founder to provide: project title", FOUNDER_TODO_PATTERN);
});
