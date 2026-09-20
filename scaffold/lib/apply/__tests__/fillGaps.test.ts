import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { applyGapInputs, gapFieldId, gapHint, USER_PROVIDED_SOURCE } from "../fillGaps";
import { PrefilledFormsSchema } from "../../contracts/applicationForms";
import type { AssembledPackage } from "../package";

function pkgWithGap(): AssembledPackage {
  return {
    opportunity_id: "opp-1",
    program_title: "Prog",
    generated_at: "2026-01-01T00:00:00.000Z",
    narrativeStatus: "unavailable",
    requirementsAvailable: false,
    narratives: [],
    draftableSections: [],
    forms: {
      opportunity_id: "opp-1",
      program_title: "Prog",
      generated_at: "2026-01-01T00:00:00.000Z",
      forms: [
        {
          form_name: "SF-424",
          fields: [
            { key: "uei", label: "UEI", status: "prefilled", value: "ABC", display: "ABC", source: "sam.uei" },
            { key: "project_title", label: "Title", status: "founder_to_provide", display: "[you to provide: project title]" },
          ],
        },
      ],
      gaps: ["[you to provide: project title]"],
    },
    budget: {
      generated_at: "2026-01-01T00:00:00.000Z",
      line_items: [],
      total: {
        range_statement: "[you to provide: total budget amount]",
        range_grounded: false,
        amount: "[you to provide: total budget amount]",
      },
      constraints: [],
      advisories: [],
      notes: [],
      gaps: ["[you to provide: total budget amount]"],
    },
    checklist: { allRegistrationsSatisfied: false },
    gaps: ["[you to provide: project title]", "[you to provide: total budget amount]"],
  } as AssembledPackage;
}

describe("applyGapInputs — filling a form gap in-app", () => {
  test("no inputs → package unchanged (structurally)", () => {
    const pkg = pkgWithGap();
    assert.deepEqual(applyGapInputs(pkg, {}), pkg);
  });

  test("filling a gap → user-sourced prefilled field, dropped from both gap lists", () => {
    const pkg = pkgWithGap();
    const out = applyGapInputs(pkg, { [gapFieldId("SF-424", "project_title")]: "Rural Biosensors Phase I" });
    const field = out.forms.forms[0].fields.find((f) => f.key === "project_title")!;
    assert.equal(field.status, "prefilled");
    assert.equal(field.value, "Rural Biosensors Phase I");
    assert.equal(field.display, "Rural Biosensors Phase I");
    assert.equal(field.source, USER_PROVIDED_SOURCE);
    assert.ok(!out.forms.gaps.includes("[you to provide: project title]"));
    assert.ok(!out.gaps.includes("[you to provide: project title]"));
    assert.ok(out.gaps.includes("[you to provide: total budget amount]")); // budget gap remains
  });

  test("the edited forms still satisfy the PrefilledForms honesty contract", () => {
    const out = applyGapInputs(pkgWithGap(), { [gapFieldId("SF-424", "project_title")]: "My Project" });
    const parsed = PrefilledFormsSchema.safeParse(out.forms);
    assert.ok(parsed.success, parsed.success ? "" : JSON.stringify(parsed.error.issues.slice(0, 2)));
  });

  test("whitespace-only input is ignored (gap stays a gap)", () => {
    const pkg = pkgWithGap();
    const out = applyGapInputs(pkg, { [gapFieldId("SF-424", "project_title")]: "   " });
    assert.equal(out.forms.forms[0].fields.find((f) => f.key === "project_title")!.status, "founder_to_provide");
    assert.deepEqual(out.gaps, pkg.gaps);
  });

  test("grounded fields and unrelated ids are never touched", () => {
    const out = applyGapInputs(pkgWithGap(), { "SF-424:uei": "SHOULD-NOT-APPLY", "bogus:id": "x" });
    const uei = out.forms.forms[0].fields.find((f) => f.key === "uei")!;
    assert.equal(uei.value, "ABC");
    assert.equal(uei.source, "sam.uei");
  });

  test("gapHint extracts the placeholder hint", () => {
    assert.equal(gapHint("[you to provide: project title]"), "project title");
    assert.equal(gapHint("ABC"), "");
  });
});
