import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { isSbirSttr, universalRulesForOpportunity } from "../universalRules";

/**
 * CAN-04 universal overlay — unit tests for `isSbirSttr` (the case-insensitive
 * title/program detector that decides whether the SBIR/STTR size + ownership
 * gates apply) and `universalRulesForOpportunity` (which universal rules fold
 * into ELG-01's `screen()` for a given opportunity). Pure logic, no network.
 *
 * `isSbirSttr` takes `Pick<CanonOpportunity, "title" | "program">` — both keys
 * are REQUIRED by that type (`title` is required on the CAN-01 store-row type;
 * `program` is required on the base Opportunity contract), so every fixture
 * below supplies both, using `""` for the field not under test to isolate the
 * signal (mirrors the function's own `${title} ${program}` concatenation).
 */

describe("isSbirSttr", () => {
  test("acronyms are detected case-insensitively, in title or program", () => {
    assert.equal(isSbirSttr({ title: "SBIR Phase I", program: "" }), true);
    assert.equal(isSbirSttr({ title: "sbir phase i", program: "" }), true);
    assert.equal(isSbirSttr({ title: "DoD STTR Topic AF241-001", program: "" }), true);
    assert.equal(isSbirSttr({ title: "", program: "DoD STTR Topic AF241-001" }), true);
  });

  test("spelled-out program names are detected", () => {
    assert.equal(
      isSbirSttr({ title: "Small Business Innovation Research Program", program: "" }),
      true,
    );
    assert.equal(
      isSbirSttr({ title: "Small Business Technology Transfer", program: "" }),
      true,
    );
  });

  test("[documented behavior] a non-word-boundary match does NOT false-positive", () => {
    // "SBIRxyz" has no word boundary after "sbir" (the acronym regex is
    // \bsbir\b), so this does not match the acronym branch, and none of the
    // spelled-out phrases appear either. Actual behavior asserted, not
    // changed — this documents the regex's real boundary semantics.
    assert.equal(isSbirSttr({ title: "SBIRxyz Program", program: "" }), false);
  });

  test("plain, unrelated titles are not SBIR/STTR", () => {
    assert.equal(isSbirSttr({ title: "Community Development Block Grant", program: "" }), false);
    assert.equal(isSbirSttr({ title: "Rural Business Development Grant", program: "" }), false);
  });

  test("empty title+program never throws and returns false", () => {
    assert.doesNotThrow(() => isSbirSttr({ title: "", program: "" }));
    assert.equal(isSbirSttr({ title: "", program: "" }), false);
  });
});

describe("universalRulesForOpportunity", () => {
  test("an SBIR/STTR opportunity gets registration + ownership + size", () => {
    const rules = universalRulesForOpportunity({
      title: "DoD SBIR Phase I Topic",
      program: "SBIR Phase I",
    });
    assert.equal(rules.length, 3);
    assert.deepEqual(
      rules.map((r) => r.id).sort(),
      ["universal-sam-registration", "universal-sbir-ownership", "universal-sbir-size"],
    );
  });

  test("a non-SBIR opportunity gets only the universal registration gate", () => {
    const rules = universalRulesForOpportunity({
      title: "Community Development Block Grant",
      program: "CDBG",
    });
    assert.equal(rules.length, 1);
    assert.equal(rules[0].id, "universal-sam-registration");
    assert.equal(rules[0].category, "registration");
  });

  // --- kind-scoped overlay (loan / scholarship / procurement) ---------------

  test("unknown kind → financial-assistance SAM gate (back-compat with legacy callers)", () => {
    const rules = universalRulesForOpportunity({ title: "Some Grant", program: "Some Grant" });
    assert.deepEqual(rules.map((r) => r.id), ["universal-sam-registration"]);
  });

  test("a grant/rd/assistance kind → the 2 CFR financial-assistance SAM gate", () => {
    for (const kind of ["grant", "rd", "assistance"] as const) {
      const rules = universalRulesForOpportunity({ title: "X", program: "X", kind });
      assert.ok(
        rules.some((r) => r.id === "universal-sam-registration"),
        `${kind} should get the financial-assistance SAM gate`,
      );
      assert.ok(!rules.some((r) => r.id === "universal-procurement-registration"), `${kind} is not procurement`);
    }
  });

  test("a procurement opportunity → the FAR SAM gate (not the 2 CFR one)", () => {
    const rules = universalRulesForOpportunity({ title: "IT Services", program: "IT Services", kind: "procurement" });
    assert.deepEqual(rules.map((r) => r.id), ["universal-procurement-registration"]);
    assert.equal(rules[0].category, "registration");
    assert.equal(rules[0].gate_kind, "conditional");
    assert.match(rules[0].citation.source_url, /52\.204-7/);
  });

  test("a loan opportunity → SAM gate + the SBA for-profit entity gate", () => {
    const rules = universalRulesForOpportunity({ title: "SBA 7(a)", program: "SBA 7(a)", kind: "loan" });
    const ids = rules.map((r) => r.id).sort();
    assert.deepEqual(ids, ["universal-loan-for-profit", "universal-sam-registration"]);
    const forProfit = rules.find((r) => r.id === "universal-loan-for-profit")!;
    assert.equal(forProfit.category, "entity_type");
    assert.equal(forProfit.gate_kind, "categorical");
    assert.match(forProfit.citation.source_url, /13\/120\.100/);
  });

  test("a scholarship opportunity → SAM gate + the individual-applicant entity gate", () => {
    const rules = universalRulesForOpportunity({ title: "Fellowship", program: "Fellowship", kind: "scholarship" });
    const ids = rules.map((r) => r.id).sort();
    assert.deepEqual(ids, ["universal-sam-registration", "universal-scholarship-individual"]);
    const individual = rules.find((r) => r.id === "universal-scholarship-individual")!;
    assert.equal(individual.category, "entity_type");
    assert.equal(individual.gate_kind, "categorical");
    assert.match(individual.citation.source_url, /34\/75\.62/);
  });

  test("every kind-scoped rule is authoritative-cited but model_inferred=false (R8.4: unreviewed → may not exclude)", () => {
    for (const kind of ["loan", "scholarship", "procurement"] as const) {
      const rules = universalRulesForOpportunity({ title: "X", program: "X", kind });
      for (const r of rules) {
        assert.equal(r.provenance, "authoritative");
        assert.equal(r.model_inferred, false);
        assert.ok(r.citation.source_url && r.citation.quote, `${r.id} must carry url + verbatim quote (§11)`);
      }
    }
  });
});
