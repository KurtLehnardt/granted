import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { resolveEffectiveLocation } from "../OpportunityFilters";

describe("resolveEffectiveLocation", () => {
  test("null selection (\"Any location\") always resolves to null", () => {
    assert.equal(resolveEffectiveLocation(null, ["California", "Illinois"]), null);
  });

  test("a selected location still present in the available list is kept", () => {
    assert.equal(resolveEffectiveLocation("Illinois", ["California", "Illinois", "North Carolina"]), "Illinois");
  });

  test("a selected location no longer in the available list falls back to null, not a stale filter", () => {
    // Mirrors the real scenario this guards: the user picks a state, then a
    // new search's matches no longer include it (different company profile).
    assert.equal(resolveEffectiveLocation("Illinois", ["California", "North Carolina"]), null);
  });

  test("an empty available list always falls back to null", () => {
    assert.equal(resolveEffectiveLocation("California", []), null);
  });
});
