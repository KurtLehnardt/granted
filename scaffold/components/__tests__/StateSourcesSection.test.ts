import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import React from "react";

import StateSourcesSection, { STATE_SOURCE_OPTIONS } from "../StateSourcesSection";

/**
 * Settings' "which states should we fetch" control. A controlled component
 * (see its own doc comment) — `selected`/`onChange` are the hermetic test
 * seam, no localStorage/network involved, same idea as ModelSection's
 * `initialInfo` seam.
 */
function render(selected: string[]) {
  return renderToStaticMarkup(React.createElement(StateSourcesSection, { selected, onChange: () => {} }));
}

describe("StateSourcesSection", () => {
  test("renders a checkbox for every toggleable state source", () => {
    const html = render([]);
    for (const opt of STATE_SOURCE_OPTIONS) {
      assert.match(html, new RegExp(opt.label));
    }
    assert.equal(STATE_SOURCE_OPTIONS.map((o) => o.id).sort().join(","), "ca-grants,il-grants,nc-grants,ut-grants");
  });

  test("reflects the default selection: CA/IL/NC checked, Utah not", () => {
    const html = render(["ca-grants", "il-grants", "nc-grants"]);
    const caInput = html.match(/<input[^>]*data-testid="state-source-ca-grants"[^>]*>/)?.[0];
    const ilInput = html.match(/<input[^>]*data-testid="state-source-il-grants"[^>]*>/)?.[0];
    const ncInput = html.match(/<input[^>]*data-testid="state-source-nc-grants"[^>]*>/)?.[0];
    const utInput = html.match(/<input[^>]*data-testid="state-source-ut-grants"[^>]*>/)?.[0];
    assert.ok(caInput && /checked/.test(caInput));
    assert.ok(ilInput && /checked/.test(ilInput));
    assert.ok(ncInput && /checked/.test(ncInput));
    assert.ok(utInput && !/checked/.test(utInput), "Utah must not be checked under the default selection");
  });

  test("Utah opted in renders it checked", () => {
    const html = render(["ut-grants"]);
    const utInput = html.match(/<input[^>]*data-testid="state-source-ut-grants"[^>]*>/)?.[0];
    assert.ok(utInput && /checked/.test(utInput));
  });

  test("Utah's checkbox carries an explanatory note about its weaker data", () => {
    const html = render([]);
    assert.match(html, /no deadlines, no eligibility info/);
  });

  test("states a toggle takes effect on the next data refresh, not instantly", () => {
    const html = render([]);
    assert.match(html, /next data refresh/);
  });
});
