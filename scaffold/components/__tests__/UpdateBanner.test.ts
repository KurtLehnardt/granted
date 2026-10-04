import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import React from "react";

import UpdateBanner, { shouldShowBanner, type CheckResponse } from "../UpdateBanner";

/**
 * UpdateBanner — covers:
 *  - a rendered smoke test (no jsdom needed; renderToStaticMarkup only needs React, same
 *    technique as components/__tests__/SettingsForm.test.ts). Effects never run under SSR, so
 *    this exercises exactly the pre-hydration render: flag off AND flag on must both render
 *    nothing — there is no "checking…" flash on first paint either way.
 *  - a pure-function table test over shouldShowBanner(), with zero rendering, across every
 *    CheckResponse state.
 *
 * Flag toggled via the same idiom as lib/flags/__tests__/accessor.test.ts: snapshot/restore
 * process.env in beforeEach/afterEach, set NEXT_PUBLIC_FLAG_UPDATE_CHECK directly.
 */

let savedEnv: NodeJS.ProcessEnv;

beforeEach(() => {
  savedEnv = { ...process.env };
  delete process.env.NEXT_PUBLIC_FLAG_UPDATE_CHECK;
});

afterEach(() => {
  process.env = savedEnv;
});

function render() {
  return renderToStaticMarkup(React.createElement(UpdateBanner));
}

describe("<UpdateBanner/> render", () => {
  test("flag off -> renders nothing", () => {
    assert.equal(render(), "");
  });

  test("flag on -> STILL renders nothing pre-effect (no 'checking…' flash on first paint)", () => {
    process.env.NEXT_PUBLIC_FLAG_UPDATE_CHECK = "true";
    assert.equal(render(), "");
  });
});

describe("shouldShowBanner", () => {
  const LOCAL_SHA = "a".repeat(40);
  const REMOTE_SHA = "b".repeat(40);

  const cases: Array<{ name: string; res: CheckResponse | null; expected: boolean }> = [
    { name: "null (no response yet)", res: null, expected: false },
    { name: "unknown", res: { state: "unknown" }, expected: false },
    { name: "up-to-date", res: { state: "up-to-date", sha: LOCAL_SHA }, expected: false },
    {
      name: "update-available",
      res: { state: "update-available", localSha: LOCAL_SHA, remoteSha: REMOTE_SHA },
      expected: true,
    },
    { name: "applying (pulling)", res: { state: "applying", phase: "pulling" }, expected: true },
    { name: "applying (installing)", res: { state: "applying", phase: "installing" }, expected: true },
    { name: "applied", res: { state: "applied" }, expected: true },
    { name: "apply-failed", res: { state: "apply-failed", message: "boom" }, expected: true },
    { name: "error", res: { state: "error", message: "boom" }, expected: false },
  ];

  for (const { name, res, expected } of cases) {
    test(`${name} -> ${expected}`, () => {
      assert.equal(shouldShowBanner(res), expected);
    });
  }
});
