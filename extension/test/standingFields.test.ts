import { describe, expect, test, beforeEach } from "vitest";
import { UNRESOLVED } from "../src/content/selectorResolver";
import { resolveStandingField, isStandingField } from "../src/content/standingFields";

function setBody(html: string): void {
  document.body.innerHTML = html;
}

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("resolveStandingField — heuristic standing-field matching", () => {
  test("matches UEI by label keyword", () => {
    setBody('<label for="u">Unique Entity Identifier (UEI)</label><input id="u" name="applicant_uei" />');
    const el = resolveStandingField("uei", document);
    expect(el).not.toBe(UNRESOLVED);
    expect((el as HTMLInputElement).id).toBe("u");
  });

  test("matches organization name by the autocomplete token", () => {
    setBody('<input id="o" autocomplete="organization" placeholder="Legal name" />');
    expect(resolveStandingField("organization_name", document)).not.toBe(UNRESOLVED);
  });

  test("matches state by autocomplete=address-level1", () => {
    setBody('<input id="s" autocomplete="address-level1" />');
    expect(resolveStandingField("applicant_state", document)).not.toBe(UNRESOLVED);
  });

  test("congressional district by label text", () => {
    setBody('<label for="cd">Applicant Congressional District</label><input id="cd" />');
    expect(resolveStandingField("applicant_congressional_district", document)).not.toBe(UNRESOLVED);
  });

  test("'state' keyword does NOT match 'Statement'/'Estimated' (word boundary)", () => {
    setBody(
      '<label for="a">Statement of need</label><input id="a" />' +
        '<label for="b">Estimated funding</label><input id="b" />',
    );
    expect(resolveStandingField("applicant_state", document)).toBe(UNRESOLVED);
  });

  test("ambiguous (>1 candidate) → UNRESOLVED (never guesses)", () => {
    setBody('<input aria-label="City" /><input aria-label="City" />');
    expect(resolveStandingField("applicant_city", document)).toBe(UNRESOLVED);
  });

  test("ignores <select> — text inputs only", () => {
    setBody('<label for="st">State</label><select id="st"><option>ID</option></select>');
    expect(resolveStandingField("applicant_state", document)).toBe(UNRESOLVED);
  });

  test("skips disabled / hidden / readonly fields", () => {
    setBody('<input aria-label="UEI" disabled />');
    expect(resolveStandingField("uei", document)).toBe(UNRESOLVED);
    setBody('<input aria-label="UEI" readonly />');
    expect(resolveStandingField("uei", document)).toBe(UNRESOLVED);
    setBody('<input aria-label="UEI" hidden />');
    expect(resolveStandingField("uei", document)).toBe(UNRESOLVED);
  });

  test("no match → UNRESOLVED", () => {
    setBody('<input aria-label="Favorite color" />');
    expect(resolveStandingField("uei", document)).toBe(UNRESOLVED);
  });
});

describe("isStandingField — only reusable-across-grants fields", () => {
  test("standing fields are recognized", () => {
    for (const k of ["uei", "authorized_representative_name", "organization_name", "applicant_street", "applicant_zip"]) {
      expect(isStandingField(k)).toBe(true);
    }
  });
  test("per-grant fields and null are NOT standing", () => {
    for (const k of ["project_title", "total_project_cost", "project_start_date", "federal_funding_requested"]) {
      expect(isStandingField(k)).toBe(false);
    }
    expect(isStandingField(null)).toBe(false);
  });
});
