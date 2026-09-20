import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  KIND_LABEL,
  KIND_ORDER,
  availableKinds,
  filterByKinds,
  groupMatchesByKind,
  type GroupableMatch,
} from "../group";
import { OpportunityKindSchema } from "../../contracts/opportunity";

/**
 * C1b — pure, hermetic tests of the type-filter + kind-grouping helpers.
 */

function m(id: string, kind: string, score: number): GroupableMatch {
  return { score, tier: "verify", opportunity: { id, kind } };
}

describe("KIND_LABEL / KIND_ORDER", () => {
  test("every OpportunityKind has a user-facing label and a canonical order slot", () => {
    for (const kind of OpportunityKindSchema.options) {
      assert.ok(KIND_LABEL[kind], `${kind} needs a label`);
      assert.ok(KIND_ORDER.includes(kind), `${kind} needs an order slot`);
    }
    assert.equal(KIND_ORDER.length, OpportunityKindSchema.options.length, "no extra/duplicate kinds");
  });
});

describe("availableKinds", () => {
  test("returns the distinct present kinds in canonical order; skips unknown/absent", () => {
    const matches = [
      m("1", "loan", 40),
      m("2", "grant", 50),
      m("3", "rd", 45),
      m("4", "grant", 30),
      m("5", "not-a-kind", 99),
      { score: 10 }, // no opportunity
    ];
    assert.deepEqual(availableKinds(matches), ["grant", "rd", "loan"]);
  });

  test("empty / nullish input → []", () => {
    assert.deepEqual(availableKinds([]), []);
    assert.deepEqual(availableKinds(null), []);
    assert.deepEqual(availableKinds(undefined), []);
  });
});

describe("filterByKinds", () => {
  const matches = [m("1", "grant", 50), m("2", "rd", 45), m("3", "loan", 40)];

  test("no active kinds → all matches (order preserved)", () => {
    assert.deepEqual(filterByKinds(matches, null).map((x) => x.opportunity!.id), ["1", "2", "3"]);
    assert.deepEqual(filterByKinds(matches, []).map((x) => x.opportunity!.id), ["1", "2", "3"]);
  });

  test("a single active kind keeps only that kind", () => {
    assert.deepEqual(filterByKinds(matches, ["rd"]).map((x) => x.opportunity!.id), ["2"]);
  });

  test("multiple active kinds keep their union", () => {
    assert.deepEqual(filterByKinds(matches, ["grant", "loan"]).map((x) => x.opportunity!.id), ["1", "3"]);
  });
});

describe("groupMatchesByKind", () => {
  test("groups by kind in canonical order; sorts within a group by score desc then id", () => {
    const matches = [
      m("g1", "grant", 30),
      m("r1", "rd", 60),
      m("g2", "grant", 55),
      m("g3", "grant", 55), // tie with g2 → id break (g2 before g3)
      m("l1", "loan", 20),
    ];
    const groups = groupMatchesByKind(matches);
    assert.deepEqual(groups.map((g) => g.kind), ["grant", "rd", "loan"], "canonical kind order");
    assert.deepEqual(groups[0].matches.map((x) => x.opportunity!.id), ["g2", "g3", "g1"], "score desc, id tie-break");
    assert.equal(groups[0].label, KIND_LABEL.grant);
  });

  test("only non-empty groups are returned; unknown-kind matches are omitted", () => {
    const groups = groupMatchesByKind([m("1", "grant", 10), m("2", "bogus", 99)]);
    assert.deepEqual(groups.map((g) => g.kind), ["grant"]);
    assert.equal(groups[0].matches.length, 1);
  });

  test("empty / nullish input → []", () => {
    assert.deepEqual(groupMatchesByKind([]), []);
    assert.deepEqual(groupMatchesByKind(null), []);
  });

  test("grouping does not mutate the input array", () => {
    const matches = [m("g1", "grant", 10), m("g2", "grant", 90)];
    const snapshot = matches.map((x) => x.opportunity!.id);
    groupMatchesByKind(matches);
    assert.deepEqual(matches.map((x) => x.opportunity!.id), snapshot);
  });
});
