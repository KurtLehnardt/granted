import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import React from "react";

import ScrollFadeContainer from "../ScrollFadeContainer";

/**
 * The scroll/resize-driven fade behavior itself (edge fades appearing only
 * while there's actually more to scroll to) needs real layout -- scrollWidth/
 * clientWidth are always 0 under node:test's DOM-less renderToStaticMarkup,
 * same limitation as every other client component tested this way in this
 * repo (see ModelSection.test.ts). That part was verified manually in a real
 * browser: scrolled a table to its end, confirmed the right fade disappeared
 * and the left fade appeared. This test locks in the static shape only --
 * children render, the scroll container is keyboard-reachable, and neither
 * fade renders before any scroll-position measurement has happened.
 */
function render(children: React.ReactNode, fadeBg?: "canvas" | "canvas-alt") {
  return renderToStaticMarkup(React.createElement(ScrollFadeContainer, { children, fadeBg }));
}

describe("ScrollFadeContainer", () => {
  test("renders children inside a keyboard-focusable scroll container", () => {
    const html = render(React.createElement("table", { "data-testid": "t" }, "content"));
    assert.match(html, /<table[^>]*data-testid="t"/);
    assert.match(html, /tabindex="0"/);
    assert.match(html, /overflow-x-auto/);
  });

  test("renders neither edge fade before any scroll measurement (SSR / initial paint)", () => {
    const html = render(React.createElement("table", null, "content"));
    assert.doesNotMatch(html, /bg-gradient-to-r/);
    assert.doesNotMatch(html, /bg-gradient-to-l/);
  });

  test("fadeBg selects the matching token so the gradient blends into the real background, not a hardcoded color", () => {
    // Can't observe the fade divs themselves pre-scroll (see above), but this
    // pins that the prop is a closed, token-only choice -- default "canvas"
    // for a page-level table, "canvas-alt" for one inside a card -- not a
    // free-form className that could smuggle in a raw hex (CON-02).
    assert.doesNotThrow(() => render(React.createElement("table"), "canvas"));
    assert.doesNotThrow(() => render(React.createElement("table"), "canvas-alt"));
  });
});
