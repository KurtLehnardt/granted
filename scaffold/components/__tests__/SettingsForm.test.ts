import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import React from "react";

import SettingsForm from "../SettingsForm";

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
});
