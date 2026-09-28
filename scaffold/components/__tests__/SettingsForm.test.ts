import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import React from "react";

import SettingsForm from "../SettingsForm";

/**
 * Auto Fill / auto-apply requirement fields (UEI, AOR, active SAM.gov
 * registration, organization name/details) are gated behind r6_auto_fill —
 * they must not render while the flag is off, and must render when it's on.
 * The rest of Settings (search depth, cached grants) is unaffected either way.
 */

const FLAG = "NEXT_PUBLIC_FLAG_R6_AUTO_FILL";
const previous = process.env[FLAG];

afterEach(() => {
  if (previous === undefined) delete process.env[FLAG];
  else process.env[FLAG] = previous;
});

function render() {
  return renderToStaticMarkup(React.createElement(SettingsForm));
}

describe("SettingsForm — r6_auto_fill gating", () => {
  test("auto-fill requirement fields are absent when the flag is off", () => {
    delete process.env[FLAG];
    const html = render();
    assert.doesNotMatch(html, /UEI \(Unique Entity Identifier\)/);
    assert.doesNotMatch(html, /Authorized AOR/);
    assert.doesNotMatch(html, /E-Biz POC delegation/);
    assert.doesNotMatch(html, /Active SAM\.gov registration/);
    assert.doesNotMatch(html, /Organization details/);
    assert.match(html, /Search depth/);
  });

  test("auto-fill requirement fields render when the flag is on", () => {
    process.env[FLAG] = "true";
    const html = render();
    assert.match(html, /UEI \(Unique Entity Identifier\)/);
    assert.match(html, /Authorized AOR/);
    assert.match(html, /E-Biz POC delegation/);
    assert.match(html, /Active SAM\.gov registration/);
    assert.match(html, /Organization details/);
    assert.match(html, /Search depth/);
  });
});
