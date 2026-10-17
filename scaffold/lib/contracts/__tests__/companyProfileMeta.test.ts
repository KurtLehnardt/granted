import { test } from "node:test";
import assert from "node:assert/strict";

import {
  CompanyProfileSchema,
  PROFILE_FIELD_META,
  PROFILE_FIELD_META_BY_KEY,
  MATERIAL_PROFILE_FIELDS,
  isFieldProvided,
  REVENUE_RANGES,
  FUNDING_STAGES,
  CAPITAL_RAISED_RANGES,
  CAPITAL_REQUIREMENT_RANGES,
} from "../companyProfile";

/**
 * §3.1a — profile field metadata (B1a). Locks in the required/optional
 * designation, the per-field input-type + enum choices, and the `isFieldProvided`
 * atom that gap-detection is built on. These are the invariants the interview's
 * "ask only missing material fields, never re-ask a provided one" guarantee
 * rests on.
 */

// --- Required / material designation ---------------------------------------

const REQUIRED_FIELDS = [
  "raw_text",
];

const MATERIAL_FIELDS = [
  "location",
  "revenue",
  "funding_stage",
  "capital_raised",
  "capital_requirement",
];

test("exactly the 1 required field is designated required", () => {
  const required = PROFILE_FIELD_META.filter((m) => m.requirement === "required").map(
    (m) => m.field,
  );
  assert.deepEqual(required.sort(), [...REQUIRED_FIELDS].sort());
});

test("exactly the 5 optional-but-material fields are designated material", () => {
  const material = PROFILE_FIELD_META.filter((m) => m.requirement === "material").map(
    (m) => m.field,
  );
  assert.deepEqual(material.sort(), [...MATERIAL_FIELDS].sort());
});

test("MATERIAL_PROFILE_FIELDS = required + material (6 fields), and excludes no interview field", () => {
  assert.equal(MATERIAL_PROFILE_FIELDS.length, 6);
  assert.equal(
    MATERIAL_PROFILE_FIELDS.every((m) => m.requirement !== "optional"),
    true,
  );
});

test("required fields sort ahead of material fields in ask-order", () => {
  const firstMaterialIdx = PROFILE_FIELD_META.findIndex(
    (m) => m.requirement === "material",
  );
  const lastRequiredIdx =
    PROFILE_FIELD_META.length -
    1 -
    [...PROFILE_FIELD_META].reverse().findIndex((m) => m.requirement === "required");
  assert.ok(lastRequiredIdx < firstMaterialIdx, "all required come before any material");
});

// --- Every metadata field key is a real CompanyProfile field ----------------

test("every metadata field key exists on the CompanyProfileSchema (no renamed/invented field)", () => {
  const shapeKeys = new Set(Object.keys(CompanyProfileSchema.shape));
  for (const m of PROFILE_FIELD_META) {
    assert.ok(shapeKeys.has(m.field), `metadata references unknown field: ${m.field}`);
  }
});

test("PROFILE_FIELD_META_BY_KEY is a faithful index of the registry", () => {
  for (const m of PROFILE_FIELD_META) {
    assert.equal(PROFILE_FIELD_META_BY_KEY[m.field], m);
  }
  assert.equal(
    Object.keys(PROFILE_FIELD_META_BY_KEY).length,
    PROFILE_FIELD_META.length,
  );
});

// --- Input-type + enum metadata --------------------------------------------

test("select/range fields carry non-empty options; free_text/integer/boolean do not", () => {
  for (const m of PROFILE_FIELD_META) {
    if (m.inputType === "single_select" || m.inputType === "range_select") {
      assert.ok(m.options && m.options.length > 0, `${m.field} needs options`);
    } else {
      assert.equal(m.options, undefined, `${m.field} should not carry options`);
    }
  }
});

test("field input types match the intended B1a semantics", () => {
  const byKey = PROFILE_FIELD_META_BY_KEY;
  assert.equal(byKey.revenue.inputType, "range_select");
  assert.equal(byKey.funding_stage.inputType, "single_select");
  assert.equal(byKey.capital_raised.inputType, "range_select");
  assert.equal(byKey.capital_requirement.inputType, "range_select");
  assert.equal(byKey.location.inputType, "single_select");
  for (const f of REQUIRED_FIELDS) assert.equal(byKey[f].inputType, "free_text");
});

test("enum option sets are wired to the right fields and have stable, unique values", () => {
  const byKey = PROFILE_FIELD_META_BY_KEY;
  assert.equal(byKey.revenue.options, REVENUE_RANGES);
  assert.equal(byKey.funding_stage.options, FUNDING_STAGES);
  assert.equal(byKey.capital_raised.options, CAPITAL_RAISED_RANGES);
  assert.equal(byKey.capital_requirement.options, CAPITAL_REQUIREMENT_RANGES);

  for (const set of [
    REVENUE_RANGES,
    FUNDING_STAGES,
    CAPITAL_RAISED_RANGES,
    CAPITAL_REQUIREMENT_RANGES,
  ]) {
    const values = set.map((o) => o.value);
    assert.equal(new Set(values).size, values.length, "option values are unique");
    assert.equal(
      values.every((v) => v.length > 0),
      true,
      "option values are non-empty",
    );
  }
});

// --- isFieldProvided --------------------------------------------------------

const cell = (value: unknown) => ({ value, provenance: "user_stated", confidence: 1 });

test("isFieldProvided: a present non-empty provenanced value is provided", () => {
  assert.equal(isFieldProvided({ industry: cell("agtech") }, "industry"), true);
  assert.equal(isFieldProvided({ employee_count: cell(12) }, "employee_count"), true);
  assert.equal(isFieldProvided({ employee_count: cell(0) }, "employee_count"), true); // 0 is a stated value
  assert.equal(isFieldProvided({ us_owned: cell(false) }, "us_owned"), true); // false is stated
  assert.equal(
    isFieldProvided({ naics_codes: cell(["541511"]) }, "naics_codes"),
    true,
  );
});

test("isFieldProvided: missing, null, blank string, or empty array is NOT provided", () => {
  assert.equal(isFieldProvided({}, "industry"), false);
  assert.equal(isFieldProvided({ industry: undefined }, "industry"), false);
  assert.equal(isFieldProvided({ industry: cell("") }, "industry"), false);
  assert.equal(isFieldProvided({ industry: cell("   ") }, "industry"), false);
  assert.equal(isFieldProvided({ naics_codes: cell([]) }, "naics_codes"), false);
  assert.equal(isFieldProvided({ industry: cell(null) }, "industry"), false);
});

test("isFieldProvided: a bare non-cell value (no { value }) is NOT provided", () => {
  // Guards against treating a stray primitive as a provenanced cell.
  assert.equal(isFieldProvided({ industry: "agtech" } as Record<string, unknown>, "industry"), false);
});

test("isFieldProvided reads a real schema-parsed profile", () => {
  const p = CompanyProfileSchema.parse({
    id: "p1",
    raw_text: cell("We build drones."),
    industry: cell("agtech"),
    interview_answers: [],
  });
  assert.equal(isFieldProvided(p, "raw_text"), true);
  assert.equal(isFieldProvided(p, "industry"), true);
  assert.equal(isFieldProvided(p, "location"), false);
});
