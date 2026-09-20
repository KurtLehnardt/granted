import { describe, expect, test, beforeEach } from "vitest";
import { runFill } from "../src/content/fillEngine";
import type { PortalFieldMap } from "../src/config/schema";
import { grantsGov } from "../src/config/portals/grants_gov";
import { validPackage } from "./fixtures/package";
import type { AssembledPackage } from "../src/lib/contracts/package";

beforeEach(() => {
  document.body.innerHTML = "";
});

/** A tiny portal config with REAL (resolvable) selectors, for exercising the write path. */
function testFieldMap(): PortalFieldMap {
  return {
    portalId: "grants_gov",
    displayName: "Test Portal",
    urlMatch: ["https://example.test/*"],
    steps: [{ stepId: "step1", title: "Step 1", order: 0 }],
    advanceControls: [],
    fields: [
      {
        packageKey: "uei",
        label: "UEI",
        elementType: "text",
        stepId: "step1",
        selector: { id: "uei-input" },
      },
      {
        packageKey: "organization_name",
        label: "Org Name",
        elementType: "text",
        stepId: "step1",
        selector: { id: "org-input" },
      },
      {
        packageKey: null,
        label: "Search box (portal-only)",
        elementType: "text",
        stepId: "step1",
        selector: { id: "search-box" },
      },
      {
        packageKey: "authorized_representative_name",
        label: "AOR Name",
        elementType: "text",
        stepId: "step1",
        role: "data",
        selector: { id: "aor-name-input" },
      },
      {
        packageKey: null,
        label: "Signature",
        elementType: "text",
        stepId: "step1",
        role: "signature",
        neverFill: true,
        selector: { id: "signature-input" },
      },
      {
        packageKey: null,
        label: "Date Signed",
        elementType: "date",
        stepId: "step1",
        role: "date_signed",
        neverFill: true,
        selector: { id: "date-signed-input" },
      },
      {
        packageKey: "not_present_in_package",
        label: "Not in package",
        elementType: "text",
        stepId: "step1",
        selector: { id: "not-in-package-input" },
      },
      {
        packageKey: "uei", // deliberately re-mapped for the password-refusal test below
        label: "Fake credential target",
        elementType: "text",
        stepId: "step_credential",
        selector: { id: "password-input" },
      },
    ],
  };
}

function pkgWithGroundedAorName(): AssembledPackage {
  const pkg = validPackage();
  pkg.forms.forms[0]!.fields.push({
    key: "authorized_representative_name",
    label: "Authorized representative (AOR) name",
    status: "prefilled",
    value: "Jamie Rivera",
    display: "Jamie Rivera",
    source: "sam.aorName",
  });
  return pkg;
}

describe("runFill — the fill algorithm (spec §3.3)", () => {
  test("INV-3: writes a grounded (prefilled) field and dispatches input/change events", () => {
    document.body.innerHTML = '<input id="uei-input" /><input id="org-input" />';
    const pkg = validPackage();
    let inputEventFired = false;
    document.getElementById("uei-input")!.addEventListener("input", () => (inputEventFired = true));

    const { results, summary } = runFill({ fieldMap: testFieldMap(), stepId: "step1", pkg });

    const ueiResult = results.find((r) => r.packageKey === "uei")!;
    expect(ueiResult.outcome).toBe("filled_verified");
    expect(ueiResult.intendedValue).toBe("ABC123XYZ789");
    expect((document.getElementById("uei-input") as HTMLInputElement).value).toBe("ABC123XYZ789");
    expect(inputEventFired).toBe(true);
    expect(summary.filledVerified).toBeGreaterThanOrEqual(1);
  });

  test("INV-2: a gap field is NEVER written to the DOM, only flagged", () => {
    document.body.innerHTML = '<input id="uei-input" /><input id="org-input" />';
    const pkg = validPackage(); // organization_name is a gap in the fixture
    const { results } = runFill({ fieldMap: testFieldMap(), stepId: "step1", pkg });

    const orgResult = results.find((r) => r.packageKey === "organization_name")!;
    expect(orgResult.outcome).toBe("gap");
    expect(orgResult.gapDisplay).toBe("[you to provide: organization legal name]");
    expect((document.getElementById("org-input") as HTMLInputElement).value).toBe("");

    // A flag badge (shadow-DOM host) is present right after the field.
    const next = document.getElementById("org-input")!.nextElementSibling;
    expect(next).not.toBeNull();
    expect(next!.getAttribute("data-granted-flag")).toBe("true");
    expect(next!.getAttribute("data-granted-flag-kind")).toBe("gap");
  });

  test("INV-4: signature/date_signed roles are excluded even if resolvable and packageKey is set", () => {
    document.body.innerHTML = '<input id="signature-input" /><input id="date-signed-input" />';
    const pkg = validPackage();
    const { results } = runFill({ fieldMap: testFieldMap(), stepId: "step1", pkg });

    const sig = results.find((r) => r.label === "Signature")!;
    const dateSigned = results.find((r) => r.label === "Date Signed")!;
    expect(sig.outcome).toBe("excluded");
    expect(dateSigned.outcome).toBe("excluded");
    expect((document.getElementById("signature-input") as HTMLInputElement).value).toBe("");
    expect((document.getElementById("date-signed-input") as HTMLInputElement).value).toBe("");
  });

  test("INV-5: refuses to fill an input[type=password] even if a binding somehow targets it", () => {
    document.body.innerHTML = '<input id="password-input" type="password" />';
    const pkg = validPackage();
    const { results } = runFill({ fieldMap: testFieldMap(), stepId: "step_credential", pkg });

    const result = results.find((r) => r.label === "Fake credential target")!;
    expect(result.outcome).toBe("refused_credential");
    expect((document.getElementById("password-input") as HTMLInputElement).value).toBe("");
  });

  test("portal-only controls (packageKey: null, no role) are skipped as portal_only", () => {
    document.body.innerHTML = '<input id="uei-input" /><input id="org-input" /><input id="search-box" />';
    const pkg = validPackage();
    const { results } = runFill({ fieldMap: testFieldMap(), stepId: "step1", pkg });
    const searchResult = results.find((r) => r.label === "Search box (portal-only)")!;
    expect(searchResult.outcome).toBe("portal_only");
  });

  test("a packageKey with no matching field in the package is flagged not_in_package", () => {
    document.body.innerHTML = '<input id="uei-input" /><input id="org-input" /><input id="not-in-package-input" />';
    const pkg = validPackage();
    const { results } = runFill({ fieldMap: testFieldMap(), stepId: "step1", pkg });
    const result = results.find((r) => r.packageKey === "not_present_in_package")!;
    expect(result.outcome).toBe("not_in_package");
  });

  test("INV-9: with an UNRESOLVABLE selector (no matching DOM element), field is flagged unmapped, never a throw", () => {
    document.body.innerHTML = "<div>completely empty page</div>";
    const pkg = validPackage();
    expect(() => runFill({ fieldMap: testFieldMap(), stepId: "step1", pkg })).not.toThrow();
    const { results, summary } = runFill({ fieldMap: testFieldMap(), stepId: "step1", pkg });
    const ueiResult = results.find((r) => r.packageKey === "uei")!;
    expect(ueiResult.outcome).toBe("unmapped");
    expect(summary.filledVerified).toBe(0);
  });

  test("INV-9: the real (all-TODO) grants_gov seed config resolves NOTHING and fills 0 fields", () => {
    document.body.innerHTML = `
      <input id="anything" />
      <select id="anything-select"></select>
    `;
    const pkg = validPackage();
    const dataFields = grantsGov.fields.filter((f) => !f.neverFill && f.role !== "signature" && f.role !== "date_signed");
    let totalFilled = 0;
    for (const step of grantsGov.steps) {
      const { summary } = runFill({ fieldMap: grantsGov, stepId: step.stepId, pkg });
      totalFilled += summary.filledVerified + summary.filledUnverified;
    }
    expect(totalFilled).toBe(0);
    expect(dataFields.length).toBeGreaterThan(0); // sanity: there ARE data fields configured
  });

  test("INV-11: idempotent re-run does not re-flag or duplicate DOM writes for an already-written field", () => {
    document.body.innerHTML = '<input id="uei-input" /><input id="org-input" />';
    const pkg = validPackage();
    const fieldMap = testFieldMap();

    const first = runFill({ fieldMap, stepId: "step1", pkg });
    const second = runFill({ fieldMap, stepId: "step1", pkg, lastWritten: first.lastWritten });

    const ueiResult2 = second.results.find((r) => r.packageKey === "uei")!;
    expect(ueiResult2.outcome).toBe("filled_verified");
    expect((document.getElementById("uei-input") as HTMLInputElement).value).toBe("ABC123XYZ789");
  });

  test("INV-11: a field the human edited since our last write is NEVER clobbered (human_edit_kept)", () => {
    document.body.innerHTML = '<input id="uei-input" /><input id="org-input" />';
    const pkg = validPackage();
    const fieldMap = testFieldMap();

    const first = runFill({ fieldMap, stepId: "step1", pkg });
    expect(first.results.find((r) => r.packageKey === "uei")!.outcome).toBe("filled_verified");

    // Simulate the human editing the field after our write.
    (document.getElementById("uei-input") as HTMLInputElement).value = "HUMAN-TYPED-VALUE";

    const second = runFill({ fieldMap, stepId: "step1", pkg, lastWritten: first.lastWritten });
    const ueiResult2 = second.results.find((r) => r.packageKey === "uei")!;
    expect(ueiResult2.outcome).toBe("human_edit_kept");
    expect((document.getElementById("uei-input") as HTMLInputElement).value).toBe("HUMAN-TYPED-VALUE");
  });

  test("INV-11: a field with pre-existing content we never wrote is treated as an edit and left alone", () => {
    document.body.innerHTML = '<input id="uei-input" value="PRE-EXISTING" /><input id="org-input" />';
    const pkg = validPackage();
    const { results } = runFill({ fieldMap: testFieldMap(), stepId: "step1", pkg });
    const ueiResult = results.find((r) => r.packageKey === "uei")!;
    expect(ueiResult.outcome).toBe("human_edit_kept");
    expect((document.getElementById("uei-input") as HTMLInputElement).value).toBe("PRE-EXISTING");
  });

  test("INV-10: filled_unverified is reported when the read-back does not match the intended value", () => {
    document.body.innerHTML = '<input id="uei-input" /><input id="org-input" />';
    const el = document.getElementById("uei-input") as HTMLInputElement;
    // Simulate a hostile/broken portal script that reverts the value on `input`.
    el.addEventListener("input", () => {
      el.value = "OVERWRITTEN-BY-PAGE";
    });
    const pkg = validPackage();
    const { results } = runFill({ fieldMap: testFieldMap(), stepId: "step1", pkg });
    const ueiResult = results.find((r) => r.packageKey === "uei")!;
    expect(ueiResult.outcome).toBe("filled_unverified");
  });

  test("grounded field with provenance renders `source` on the FillResult for popup display", () => {
    document.body.innerHTML = '<input id="uei-input" /><input id="org-input" />';
    const pkg = validPackage();
    const { results } = runFill({ fieldMap: testFieldMap(), stepId: "step1", pkg });
    const ueiResult = results.find((r) => r.packageKey === "uei")!;
    expect(ueiResult.source).toBe("sam.uei");
  });

  test("an identity (role: data) field on Box 21 fills normally when grounded", () => {
    document.body.innerHTML = '<input id="uei-input" /><input id="org-input" /><input id="aor-name-input" />';
    const pkg = pkgWithGroundedAorName();
    const { results } = runFill({ fieldMap: testFieldMap(), stepId: "step1", pkg });
    const aorResult = results.find((r) => r.packageKey === "authorized_representative_name")!;
    expect(aorResult.outcome).toBe("filled_verified");
    expect((document.getElementById("aor-name-input") as HTMLInputElement).value).toBe("Jamie Rivera");
  });
});
