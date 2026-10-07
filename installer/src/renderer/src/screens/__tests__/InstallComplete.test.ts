/**
 * The Installation-complete screen's macOS "Add Granted to the Dock" box,
 * rendered for real with react-dom/server — the same renderToStaticMarkup
 * smoke-test convention the app's own component tests use
 * (scaffold/components/__tests__/*), and for the same reason: no jsdom, no
 * test renderer, just the markup React actually produces.
 *
 * The screen itself only learns it is on macOS from an effect
 * (window.api.getSetupState), which static rendering never runs, so the
 * checkbox is exported on its own and rendered here directly. What the
 * installer then does with it — create the launcher, with or without the Dock
 * entry — is covered end to end by e2e/macInstall.spec.ts and by
 * src/main/__tests__/macLauncher.integration.test.ts.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import InstallComplete, { AddToDockOption } from "../InstallComplete";

const render = (addToDock: boolean): string =>
  renderToStaticMarkup(React.createElement(AddToDockOption, { addToDock, onChange: () => {} }));

describe("Installation complete → Add Granted to the Dock", () => {
  test("it is a checkbox, ticked by default, labelled for the Dock", () => {
    const html = render(true);
    assert.match(html, /type="checkbox"/);
    assert.match(html, /checked=""/);
    assert.match(html, /Add Granted to the Dock/);
  });

  test("unticked renders unchecked", () => {
    assert.ok(!render(false).includes("checked"));
  });

  test("it says the Applications launcher happens either way — unticking only leaves the Dock alone", () => {
    const html = render(true);
    // Both the hover title and the accessible description, so this reads the
    // same to a screen reader as it does to a mouse.
    assert.match(html, /title="Granted is added to your Applications folder either way\./);
    assert.match(html, /aria-description="Granted is added to your Applications folder either way\./);
    assert.match(html, /Untick to leave your Dock as it is\./);
  });

  test("the screen itself renders before its setup state arrives", () => {
    // No window.api here at all: a static render must not reach for it.
    const html = renderToStaticMarkup(React.createElement(InstallComplete));
    assert.match(html, /Installation complete/);
    // Nothing is offered until the main process says what this install has.
    assert.ok(!html.includes("Add Granted to the Dock"));
  });
});
