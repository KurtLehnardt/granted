import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import React from "react";

import SettingsForm, { shouldNudgeRefresh } from "../SettingsForm";

/**
 * The SAM.gov / UEI / AOR / E-Biz auto-fill requirement fields (and the
 * standing organization-details form) were removed along with the rest of
 * the Auto Fill / assisted-apply surface — this asserts they stay gone and
 * the remaining settings (search depth, model, cached grants) still render.
 */

function render() {
  return renderToStaticMarkup(React.createElement(SettingsForm));
}

describe("SettingsForm", () => {
  test("no auto-fill / SAM.gov registration fields render", () => {
    const html = render();
    assert.doesNotMatch(html, /UEI \(Unique Entity Identifier\)/);
    assert.doesNotMatch(html, /Authorized AOR/);
    assert.doesNotMatch(html, /E-Biz POC delegation/);
    assert.doesNotMatch(html, /Active SAM\.gov registration/);
    assert.doesNotMatch(html, /Organization details/);
  });

  test("the rest of Settings still renders", () => {
    const html = render();
    assert.match(html, /Search depth/);
    assert.match(html, /Replay welcome guide/);
  });

  test("the new state-sources control is mounted in the cached-grant-data section", () => {
    const html = render();
    assert.match(html, /State grant sources/);
    assert.match(html, /data-testid="state-sources-section"/);
    assert.match(html, /data-testid="state-source-ut-grants"/);
  });

  test("no nudge hint on first render (nothing has been checked yet)", () => {
    assert.doesNotMatch(render(), /Click to fetch data for your newly selected states/);
  });
});

describe("shouldNudgeRefresh", () => {
  test("checking a state whose source isn't cached nudges", () => {
    assert.equal(shouldNudgeRefresh([], ["ut-grants"], { "grants.gov": 1000, "ca-grants": 142 }), true);
  });

  test("checking a state whose source is already cached does not nudge", () => {
    assert.equal(shouldNudgeRefresh([], ["ca-grants"], { "grants.gov": 1000, "ca-grants": 142 }), false);
  });

  test("a source present with a 0 count still nudges (same as absent)", () => {
    assert.equal(shouldNudgeRefresh([], ["ca-grants"], { "grants.gov": 1000, "ca-grants": 0 }), true);
  });

  test("unchecking a box never nudges, even if other state sources are missing", () => {
    assert.equal(shouldNudgeRefresh(["ca-grants", "ut-grants"], ["ca-grants"], { "grants.gov": 1000 }), false);
  });

  test("checking a second, already-cached state alongside a first does not re-nudge for it", () => {
    // Only the newly ADDED id(s) matter -- il-grants was already selected and cached.
    assert.equal(
      shouldNudgeRefresh(["il-grants"], ["il-grants", "ca-grants"], { "il-grants": 50, "ca-grants": 142 }),
      false,
    );
  });

  test("checking two states at once, only one of them uncached, still nudges", () => {
    assert.equal(shouldNudgeRefresh([], ["ca-grants", "ut-grants"], { "ca-grants": 142 }), true);
  });

  test("no corpus status yet (sourceCounts unknown) -> nudges on any newly checked state", () => {
    assert.equal(shouldNudgeRefresh([], ["ca-grants"], {}), true);
  });
});
