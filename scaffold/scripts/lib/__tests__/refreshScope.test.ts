import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { shouldFetchFederal, shouldFetchState } from "../refreshScope.mjs";

describe("shouldFetchState", () => {
  test("null onlySource (a normal refresh) fetches every state", () => {
    assert.equal(shouldFetchState(null, "ca-grants"), true);
    assert.equal(shouldFetchState(null, "ut-grants"), true);
  });

  test("a scoped refresh fetches only the matching state", () => {
    assert.equal(shouldFetchState("ut-grants", "ut-grants"), true);
  });

  test("a scoped refresh skips every OTHER state, even if selected", () => {
    assert.equal(shouldFetchState("ut-grants", "ca-grants"), false);
    assert.equal(shouldFetchState("ut-grants", "il-grants"), false);
  });
});

describe("shouldFetchFederal", () => {
  test("null onlySource (a normal refresh) always fetches federal", () => {
    assert.equal(shouldFetchFederal(null, true), true);
    assert.equal(shouldFetchFederal(null, false), true);
  });

  test("a scoped refresh skips federal when a prior fetch already exists on disk", () => {
    assert.equal(shouldFetchFederal("ut-grants", true), false);
  });

  test("a scoped refresh still fetches federal when nothing was ever fetched before (nothing to fall back on)", () => {
    assert.equal(shouldFetchFederal("ut-grants", false), true);
  });
});
