import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import React from "react";

import ProfileQuestionnaire, {
  computeGaps,
  buildDescriptionFromProfile,
  mapStartupProfileToValues,
  computeFieldCell,
  isWideField,
  requiredProgressText,
  fieldValidationMessage,
  MATERIAL_FIELD_GROUPS,
} from "../ProfileQuestionnaire";
import { PROFILE_FIELD_META_BY_KEY, MATERIAL_PROFILE_FIELDS, PROFILE_FIELD_META } from "@/lib/contracts/companyProfile";
import type { StartupProfile } from "@/lib/types";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

/**
 * B1b — ProfileQuestionnaire's pure logic (no React, no network, no DOM):
 * gap detection, description compilation, autofill mapping, the
 * provenance-guarded field-write atom, and (F2) the UX-polish helpers —
 * responsive field-grid layout, optional-field grouping, progress copy, and
 * inline required-field validation. These are exactly the pieces the
 * "never re-ask a provided field" and "fully-filled -> zero interview
 * questions" acceptance criteria rest on, plus F2's "existing tests stay
 * green, new UX affordances get covered" bar.
 *
 * This file IS covered by the `npm test` glob (`components/**` is included
 * alongside `lib/**`, `app/**`, `scripts/**`), and is also runnable directly:
 * `node --import tsx --test components/__tests__/ProfileQuestionnaire.test.ts`.
 * Kept co-located per the repo's existing __tests__ convention.
 */

function cell<T>(value: T, provenance: "user_stated" | "model_inferred" | "verified" = "user_stated") {
  return { value, provenance, confidence: provenance === "user_stated" || provenance === "verified" ? 1 : 0.6 };
}

// --- computeGaps -------------------------------------------------------

test("computeGaps: an empty profile reports all 13 required+material fields missing", () => {
  const gaps = computeGaps({});
  assert.equal(gaps.length, MATERIAL_PROFILE_FIELDS.length);
});

test("computeGaps: a fully-filled profile reports zero gaps", () => {
  const profile: Record<string, unknown> = {};
  for (const m of MATERIAL_PROFILE_FIELDS) {
    profile[m.field] = cell(m.inputType === "integer" ? 5 : "some value");
  }
  assert.deepEqual(computeGaps(profile), []);
});

test("computeGaps: never lists a field that's already provided (never re-ask)", () => {
  const gaps = computeGaps({ industry: cell("agtech"), location: cell("Ohio") });
  assert.ok(!gaps.some((g) => g.field === "industry"));
  assert.ok(!gaps.some((g) => g.field === "location"));
  assert.ok(gaps.some((g) => g.field === "technology")); // still missing
});

// --- buildDescriptionFromProfile ----------------------------------------

test("buildDescriptionFromProfile: raw_text alone with no other fields returns just the raw text", () => {
  const desc = buildDescriptionFromProfile({ raw_text: cell("We build drones.") });
  assert.equal(desc, "We build drones.");
});

test("buildDescriptionFromProfile: folds in every OTHER provided field as a labeled line", () => {
  const desc = buildDescriptionFromProfile({
    raw_text: cell("We build drones."),
    industry: cell("agtech"),
    employee_count: cell(12),
  });
  assert.ok(desc.startsWith("We build drones."));
  assert.ok(desc.includes(`${PROFILE_FIELD_META_BY_KEY.industry.label}: agtech`));
  assert.ok(desc.includes(`${PROFILE_FIELD_META_BY_KEY.employee_count.label}: 12`));
});

test("buildDescriptionFromProfile: an empty profile returns an empty string, never throws", () => {
  assert.equal(buildDescriptionFromProfile({}), "");
});

// --- mapStartupProfileToValues ------------------------------------------

test("mapStartupProfileToValues: maps every v1 StartupProfile field onto its B1a key", () => {
  const sp: StartupProfile = {
    description: "We build drones.",
    industry: "agtech",
    technology: "computer vision",
    location: "Columbus, OH",
    employees: 7.6,
    revenue: "$500K ARR",
    fundingStage: "Seed",
    capitalRaised: "$1M",
    rdActivities: "Yes, ongoing sensor R&D",
    productMaturity: "MVP",
    targetCustomers: "Mid-size farms",
    capitalRequirement: "$2M",
  };
  const values = mapStartupProfileToValues(sp);
  assert.equal(values.raw_text, "We build drones.");
  assert.equal(values.industry, "agtech");
  assert.equal(values.technology, "computer vision");
  assert.equal(values.location, "Columbus, OH");
  assert.equal(values.employee_count, "8"); // rounded
  assert.equal(values.revenue, "$500K ARR");
  assert.equal(values.funding_stage, "Seed");
  assert.equal(values.capital_raised, "$1M");
  assert.equal(values.rd_activities, "Yes, ongoing sensor R&D");
  assert.equal(values.product_maturity, "MVP");
  assert.equal(values.target_customers, "Mid-size farms");
  assert.equal(values.capital_requirement, "$2M");
});

test("mapStartupProfileToValues: absent/blank v1 fields are simply omitted, never fabricated", () => {
  const values = mapStartupProfileToValues({ description: "" } as StartupProfile);
  assert.deepEqual(values, {});
});

// --- computeFieldCell (provenance-guarded write atom) --------------------

test("computeFieldCell: a user_stated write to an empty field succeeds", () => {
  const meta = PROFILE_FIELD_META_BY_KEY.industry;
  const result = computeFieldCell(meta, "agtech", "user_stated", undefined);
  assert.deepEqual(result, { value: "agtech", provenance: "user_stated", confidence: 1 });
});

test("computeFieldCell: a model_inferred autofill guess NEVER overwrites an existing user_stated fact", () => {
  const meta = PROFILE_FIELD_META_BY_KEY.industry;
  const result = computeFieldCell(meta, "biotech (guessed)", "model_inferred", { provenance: "user_stated" });
  assert.equal(result, null);
});

test("computeFieldCell: a model_inferred guess MAY replace another model_inferred guess", () => {
  const meta = PROFILE_FIELD_META_BY_KEY.industry;
  const result = computeFieldCell(meta, "agtech v2", "model_inferred", { provenance: "model_inferred" });
  assert.ok(result);
  assert.equal(result?.value, "agtech v2");
});

test("computeFieldCell: a user_stated edit always wins, even over an existing user_stated value", () => {
  const meta = PROFILE_FIELD_META_BY_KEY.industry;
  const result = computeFieldCell(meta, "corrected industry", "user_stated", { provenance: "user_stated" });
  assert.ok(result);
  assert.equal(result?.value, "corrected industry");
});

test("computeFieldCell: integer fields coerce and round; non-numeric input is rejected", () => {
  const meta = PROFILE_FIELD_META_BY_KEY.employee_count;
  assert.deepEqual(computeFieldCell(meta, "12.6", "user_stated", undefined), {
    value: 13,
    provenance: "user_stated",
    confidence: 1,
  });
  assert.equal(computeFieldCell(meta, "not a number", "user_stated", undefined), null);
});

test("computeFieldCell: a blank string never produces a cell", () => {
  const meta = PROFILE_FIELD_META_BY_KEY.industry;
  assert.equal(computeFieldCell(meta, "   ", "user_stated", undefined), null);
});

// --- isWideField (responsive field-grid layout) --------------------------

test("isWideField: the big description box and the two long-answer fields span both grid columns", () => {
  assert.equal(isWideField("raw_text"), true);
  assert.equal(isWideField("rd_activities"), true);
  assert.equal(isWideField("target_customers"), true);
});

test("isWideField: compact controls (selects, integer, other free-text) stay half-width", () => {
  assert.equal(isWideField("industry"), false);
  assert.equal(isWideField("technology"), false);
  assert.equal(isWideField("location"), false);
  assert.equal(isWideField("use_of_funds"), false);
  assert.equal(isWideField("employee_count"), false);
  assert.equal(isWideField("revenue"), false);
  assert.equal(isWideField("funding_stage"), false);
  assert.equal(isWideField("capital_raised"), false);
  assert.equal(isWideField("product_maturity"), false);
  assert.equal(isWideField("capital_requirement"), false);
});

// --- MATERIAL_FIELD_GROUPS (progressive-disclosure grouping) -------------

test("MATERIAL_FIELD_GROUPS: covers every optional-but-material field exactly once, and nothing else", () => {
  const materialFieldKeys = PROFILE_FIELD_META.filter((m) => m.requirement === "material").map((m) => m.field);
  const groupedKeys = MATERIAL_FIELD_GROUPS.flatMap((g) => g.fields);

  // Every material field appears somewhere in the grouping...
  for (const key of materialFieldKeys) {
    assert.ok(groupedKeys.includes(key), `${key} is missing from MATERIAL_FIELD_GROUPS`);
  }
  // ...exactly once (no field silently duplicated across two group headings)...
  const seen = new Set<string>();
  for (const key of groupedKeys) {
    assert.ok(!seen.has(key), `${key} appears in more than one group`);
    seen.add(key);
  }
  // ...and nothing in the grouping is a required or unknown field (the
  // grouping is presentation for the OPTIONAL section only).
  for (const key of groupedKeys) {
    assert.ok(materialFieldKeys.includes(key), `${key} in MATERIAL_FIELD_GROUPS is not a material field`);
  }
  assert.equal(groupedKeys.length, materialFieldKeys.length);
});

test("MATERIAL_FIELD_GROUPS: every group has a non-empty heading and at least one field", () => {
  for (const group of MATERIAL_FIELD_GROUPS) {
    assert.ok(group.heading.trim().length > 0);
    assert.ok(group.fields.length > 0);
  }
});

// --- requiredProgressText (progressive-disclosure progress copy) ---------

test("requiredProgressText: none complete yet", () => {
  assert.equal(requiredProgressText(5, 5), "0 of 5 required fields complete");
});

test("requiredProgressText: partially complete", () => {
  assert.equal(requiredProgressText(5, 2), "3 of 5 required fields complete");
});

test("requiredProgressText: all complete renders nothing", () => {
  assert.equal(requiredProgressText(5, 0), null);
});

test("requiredProgressText: singular field count doesn't say '1 fields'", () => {
  assert.equal(requiredProgressText(1, 1), "0 of 1 required field complete");
});

// --- fieldValidationMessage (inline required-field validation) -----------

test("fieldValidationMessage: a required field that's missing and untouched shows nothing (no wall of errors on a fresh form)", () => {
  const meta = PROFILE_FIELD_META_BY_KEY.industry;
  assert.equal(fieldValidationMessage(meta, false, false), null);
});

test("fieldValidationMessage: a required field that's missing AND touched shows a message naming the field", () => {
  const meta = PROFILE_FIELD_META_BY_KEY.industry;
  const msg = fieldValidationMessage(meta, false, true);
  assert.equal(msg, "Industry / market is required.");
});

test("fieldValidationMessage: a required field that's provided shows nothing, touched or not", () => {
  const meta = PROFILE_FIELD_META_BY_KEY.industry;
  assert.equal(fieldValidationMessage(meta, true, true), null);
  assert.equal(fieldValidationMessage(meta, true, false), null);
});

test("fieldValidationMessage: a material (optional) field NEVER produces a message, even missing and touched", () => {
  const meta = PROFILE_FIELD_META_BY_KEY.employee_count;
  assert.equal(fieldValidationMessage(meta, false, true), null);
  assert.equal(fieldValidationMessage(meta, false, false), null);
});

// --- rendering: no "Edit" gate, ever --------------------------------------
//
// Every field is a directly-editable control from the first paint — there is
// no read-only summary row that a saved value swaps into, so there is no
// "Edit" button to click before typing/deleting works. `renderToStaticMarkup`
// only exercises the component's first render (no effects, so localStorage
// hydration never runs here) — but since the render function no longer
// branches on "is this field provided" at all, the first render already
// proves every field, saved-value or not, takes the same directly-editable
// path. The source-text checks below additionally lock that the old
// Edit-mode state/handlers can't quietly come back.

test("ProfileQuestionnaire: required fields render as directly editable controls, with no Edit button anywhere", () => {
  const html = renderToStaticMarkup(React.createElement(ProfileQuestionnaire, { onSubmit: () => {} }));
  assert.doesNotMatch(html, />\s*Edit\s*</);
  assert.doesNotMatch(html, /aria-label="Edit /);
  for (const meta of PROFILE_FIELD_META.filter((m) => m.requirement === "required")) {
    assert.match(html, new RegExp(`<textarea[^>]*id="pq-${meta.field}"`));
  }
});

test("ProfileQuestionnaire: the old Edit-mode state, handlers, and summary row are gone from the source", () => {
  const source = readFileSync(join(__dirname, "..", "ProfileQuestionnaire.tsx"), "utf8");
  for (const banned of ["editingFields", "startEdit", "stopEdit", "pendingFocusFieldRef", "providedRowClass", "editButtonClass"]) {
    assert.doesNotMatch(source, new RegExp(banned));
  }
});
