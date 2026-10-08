import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import React from "react";

import StateSourcesSection, { cachedCountLabel, STATE_SOURCE_OPTIONS } from "../StateSourcesSection";

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

  test("shows each state's real cached count", () => {
    const html = renderToStaticMarkup(
      React.createElement(StateSourcesSection, {
        selected: ["ca-grants"],
        onChange: () => {},
        counts: { "ca-grants": 142, "ut-grants": 0 },
      }),
    );
    assert.match(html, /142 cached/);
    assert.match(html, /not cached yet/); // ut-grants: 0
  });

  test("no counts prop at all -> every state shows \"not cached yet\", never crashes", () => {
    const html = render(["ca-grants"]);
    assert.match(html, /not cached yet/);
  });

  test("per-state refresh link only renders for a CHECKED state, and only with onRefreshOne provided", () => {
    const checkedNoHandler = render(["ca-grants"]); // default render() passes no onRefreshOne
    assert.doesNotMatch(checkedNoHandler, /data-testid="state-source-refresh-ca-grants"/);

    const withHandler = renderToStaticMarkup(
      React.createElement(StateSourcesSection, { selected: ["ca-grants"], onChange: () => {}, onRefreshOne: () => {} }),
    );
    assert.match(withHandler, /data-testid="state-source-refresh-ca-grants"/);
    assert.doesNotMatch(withHandler, /data-testid="state-source-refresh-il-grants"/); // il-grants not selected
  });

  test("the per-state refresh link is disabled and relabeled while a refresh is already running", () => {
    const html = renderToStaticMarkup(
      React.createElement(StateSourcesSection, {
        selected: ["ca-grants"],
        onChange: () => {},
        onRefreshOne: () => {},
        refreshing: true,
      }),
    );
    const btn = html.match(/<button[^>]*data-testid="state-source-refresh-ca-grants"[^>]*>/)?.[0];
    assert.ok(btn && /disabled/.test(btn));
    assert.match(html, />Refreshing…</);
  });
});

describe("cachedCountLabel", () => {
  test("a positive count is formatted with thousands separators", () => {
    assert.equal(cachedCountLabel(1234), "1,234 cached");
  });

  test("0, undefined, and missing all read as \"not cached yet\"", () => {
    assert.equal(cachedCountLabel(0), "not cached yet");
    assert.equal(cachedCountLabel(undefined), "not cached yet");
  });
});
