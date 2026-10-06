import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import React from "react";
import AppUpdateSection, { noteFor } from "../AppUpdateSection";
import { waitForUpdate } from "../useAppUpdate";
import type { AppUpdateInfo } from "@/app/api/app/update/handler";

const base: AppUpdateInfo = {
  version: "0.1.1",
  latest: null,
  updateAvailable: false,
  checkFailed: false,
  canUpdate: true,
  reason: null,
  autoUpdate: false,
  status: null,
  releasesPage: "https://github.com/KurtLehnardt/granted/releases/latest",
};
const render = (info: AppUpdateInfo) => renderToStaticMarkup(React.createElement(AppUpdateSection, { initialInfo: info }));
const text = (node: React.ReactNode) => renderToStaticMarkup(React.createElement(React.Fragment, null, node));
const idle = { id: "idle" } as const;

describe("Settings → About Granted", () => {
  test("shows the version, Check for updates, and the auto-update box on an installer-made install", () => {
    const html = render(base);
    assert.match(html, /Granted v0\.1\.1/);
    assert.match(html, />Check for updates</);
    assert.match(html, /Install updates automatically/);
    assert.doesNotMatch(html, /Update to/);
  });

  test("an update available on an install that can update itself: an Update button", () => {
    const html = render({ ...base, latest: "v0.2.0", updateAvailable: true });
    assert.match(html, />Update to v0\.2\.0</);
  });

  test("a copy that can't update itself: no auto-update box, no Update button", () => {
    const html = render({ ...base, canUpdate: false, reason: "not-installer-made", latest: "v0.2.0", updateAvailable: true });
    assert.doesNotMatch(html, /Install updates automatically/);
    assert.doesNotMatch(html, /Update to/);
  });

  test("the auto-update box reflects the saved setting", () => {
    assert.match(render({ ...base, autoUpdate: true }), /type="checkbox" checked=""/);
  });
});

describe("what it says", () => {
  test("after a check", () => {
    assert.equal(noteFor(base, true, idle), "You're up to date.");
    assert.equal(noteFor({ ...base, latest: "v0.2.0", updateAvailable: true }, true, idle), "Granted v0.2.0 is available.");
    assert.match(String(noteFor({ ...base, checkFailed: true }, true, idle)), /Couldn't reach GitHub/);
    assert.match(
      String(noteFor({ ...base, canUpdate: false, reason: "not-installer-made", latest: "v0.2.0", updateAvailable: true }, true, idle)),
      /developer checkout: update it with git pull/,
    );
    assert.match(
      text(noteFor({ ...base, canUpdate: false, reason: "not-windows", latest: "v0.2.0", updateAvailable: true }, true, idle)),
      /download it from the releases page/,
    );
  });

  test("before a check: nothing, or the last update's outcome while it's still news", () => {
    assert.equal(noteFor(base, false, idle), "");
    assert.equal(noteFor({ ...base, status: { state: "done", to: "v0.1.1" } }, false, idle), "Updated to Granted v0.1.1.");
    assert.equal(noteFor({ ...base, status: { state: "error", to: "v0.2.0", message: "npm ci failed" } }, false, idle), "npm ci failed");
    // An old failure to reach a version that IS now installed: not news.
    assert.equal(noteFor({ ...base, status: { state: "error", to: "v0.1.1", message: "old" } }, false, idle), "");
    // REGRESSION (review): nor one for a version older than what's now installed (updated another way since).
    assert.equal(noteFor({ ...base, version: "0.3.0", status: { state: "error", to: "v0.2.0", message: "old" } }, false, idle), "");
  });

  test("while updating", () => {
    assert.match(String(noteFor(base, true, { id: "updating", to: "v0.2.0" })), /Updating Granted to v0\.2\.0… Granted will close and reopen by itself/);
    assert.equal(noteFor(base, true, { id: "starting" }), "Starting the update…");
  });
});

describe("waiting through the restart", () => {
  const fakeClock = () => {
    let t = 0;
    return { now: () => t, sleep: async (ms: number) => void (t += ms) };
  };
  const answers = (seq: Array<AppUpdateInfo | "down">) => {
    let i = 0;
    return (async () => {
      const a = seq[Math.min(i++, seq.length - 1)];
      if (a === "down") throw new Error("ECONNREFUSED");
      return new Response(JSON.stringify(a), { status: 200 });
    }) as unknown as typeof fetch;
  };

  test("server down for a while, then back on the new version -> ok", async () => {
    const c = fakeClock();
    const outcome = await waitForUpdate("v0.2.0", null, { ...c, fetchImpl: answers([base, "down", "down", { ...base, version: "0.2.0" }]) });
    assert.deepEqual(outcome, { ok: true });
  });

  test("the updater reports an error -> its message", async () => {
    const c = fakeClock();
    const failed = { ...base, status: { state: "error" as const, to: "v0.2.0", message: "The update didn't finish: npm ci failed" } };
    assert.deepEqual(await waitForUpdate("v0.2.0", null, { ...c, fetchImpl: answers(["down", failed]) }), {
      ok: false,
      message: "The update didn't finish: npm ci failed",
    });
  });

  test("REGRESSION (review): an earlier attempt's error for the same release is ignored — only this attempt's counts", async () => {
    const c = fakeClock();
    const old = { ...base, status: { state: "error" as const, to: "v0.2.0", message: "old failure", at: "2026-01-01T00:00:00.000Z" } };
    const outcome = await waitForUpdate("v0.2.0", "2026-10-05T12:00:00.000Z", { ...c, fetchImpl: answers([old, "down", { ...base, version: "0.2.0" }]) });
    assert.deepEqual(outcome, { ok: true });
  });

  test("never comes back -> gives up with a clear message", async () => {
    const c = fakeClock();
    const outcome = await waitForUpdate("v0.2.0", null, { ...c, timeoutMs: 60_000, fetchImpl: answers(["down"]) });
    assert.equal(outcome.ok, false);
    assert.match((outcome as { message: string }).message, /taking much longer than expected/);
  });
});
