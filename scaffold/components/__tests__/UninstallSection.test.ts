import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import React from "react";
import UninstallSection, {
  uninstallAllowed,
  uninstallRefusalMessage,
  uninstallRequest,
  type UninstallStage,
} from "../UninstallSection";
import type { AppUninstallInfo } from "@/app/api/app/uninstall/handler";
import type { UninstallOutcome } from "@/lib/appUpdate/install";

const base: AppUninstallInfo = {
  canUninstall: true,
  reason: null,
  installDir: "/Users/a/granted",
  unsaved: [],
  keyFiles: ["/Users/a/granted/scaffold/.env.local"],
  backupDir: "/Users/a/Documents/Granted backup 2026-10-06 1200",
  running: false,
  outcome: null,
};
const render = (info: AppUninstallInfo, stage?: UninstallStage) =>
  renderToStaticMarkup(React.createElement(UninstallSection, { initialInfo: info, initialStage: stage }));

describe("Settings → About Granted → Uninstall Granted", () => {
  test("an installer-made macOS install: the button, and what it would delete", () => {
    const html = render(base);
    assert.match(html, />Uninstall Granted</);
    assert.match(html, /\/Users\/a\/granted/);
    assert.match(html, /Git and Node stay installed/);
    // Nothing is confirmed yet, so there is nothing that starts an uninstall.
    assert.doesNotMatch(html, /Uninstall Granted now/);
  });

  test("nothing at all where uninstalling from here isn't a thing", () => {
    for (const reason of ["not-macos", "not-installer-made", "no-uninstaller"] as const) {
      assert.equal(render({ ...base, canUninstall: false, reason }), "", `${reason} shows nothing`);
    }
  });

  test("the confirm step says what goes, offers to keep the keys, and names where the copy goes", () => {
    const html = render(base, { id: "confirm" });
    assert.match(html, /Uninstall Granted\? This deletes \/Users\/a\/granted/);
    assert.match(html, /Keep a copy of my API keys and settings/);
    assert.match(html, /type="checkbox" checked=""/, "keeping a copy is on by default");
    assert.match(html, /Granted backup 2026-10-06 1200/);
    assert.match(html, />Cancel</);
    assert.match(html, />Uninstall Granted now</);
    // Nothing to acknowledge on a clean folder, so the button is live.
    assert.doesNotMatch(html, /Uninstall Granted now<\/button>[\s\S]*disabled/);
    assert.doesNotMatch(html, /disabled=""[\s\S]*Uninstall Granted now/);
  });

  test("with no API-key files there is nothing to offer to keep", () => {
    const html = render({ ...base, keyFiles: [] }, { id: "confirm" });
    assert.doesNotMatch(html, /Keep a copy of my API keys/);
    assert.doesNotMatch(html, /Granted backup/);
  });

  test("unsaved work is listed, and has to be acknowledged on its own before anything can start", () => {
    const html = render({ ...base, unsaved: ["changed or new files (2)", "commits that aren't pushed (1)"] }, { id: "confirm" });
    assert.match(html, /work that isn&#x27;t saved to GitHub/);
    assert.match(html, /changed or new files \(2\)/);
    assert.match(html, /commits that aren&#x27;t pushed \(1\)/);
    assert.match(html, /Delete that work too/);
    // The button that starts it is disabled until that box is ticked.
    assert.match(html, /disabled=""/);
  });

  // REGRESSION (review): this used to say "Granted is being uninstalled… you
  // can close the window" the moment the script had been SPAWNED, which is
  // before the script has decided anything — and it can still refuse, leaving
  // Granted installed and running. What is true at that point is that an
  // uninstall was started.
  test("after starting: an uninstall was STARTED, not finished, and the refusal would show here", () => {
    const html = render(base, { id: "started", backupDir: "/Users/a/Documents/Granted backup 2026-10-06 1200" });
    assert.match(html, /An uninstall was started/);
    assert.doesNotMatch(html, /Granted is being uninstalled/, "nothing claims it has happened");
    assert.doesNotMatch(html, /was uninstalled/);
    assert.match(html, /this page stops working/);
    assert.match(html, /stops without removing anything, it says so here/);
    assert.match(html, /A copy of your API keys and settings is going to \/Users\/a\/Documents\/Granted backup/);
  });

  test("an uninstaller that refused says what happened, and offers the button again", () => {
    const outcome: UninstallOutcome = {
      removed: false,
      reason: "access-denied",
      detail: "mv: rename /Users/a/granted: Permission denied",
      keptKeys: "/Users/a/Documents/Granted backup 2026-10-06 1200",
      leftover: null,
    };
    const html = render(base, { id: "refused", outcome });
    assert.match(html, /nothing was deleted/);
    assert.match(html, /Granted is still installed/);
    assert.match(html, /Permission denied/, "and what the script itself said");
    assert.match(html, /A copy of your API keys and settings is in /, "the copy it did make is still named");
    assert.match(html, />Back</, "and there is a way back to the button");
  });

  test("a failure says so and offers to report it", () => {
    const html = render(base, { id: "error", message: "This folder has work that isn't saved to GitHub", errorId: "a1b2c3d4" });
    assert.match(html, /This folder has work that isn&#x27;t saved to GitHub/);
    assert.match(html, /Report this problem/i);
  });
});

describe("the two decisions, on their own", () => {
  test("uninstallAllowed: a clean folder any time, a dirty one only once acknowledged", () => {
    assert.equal(uninstallAllowed({ unsaved: [], acknowledged: false }), true);
    assert.equal(uninstallAllowed({ unsaved: ["changed or new files (1)"], acknowledged: false }), false);
    assert.equal(uninstallAllowed({ unsaved: ["changed or new files (1)"], acknowledged: true }), true);
  });

  // force is not a switch of its own: it IS the acknowledgement, and is never
  // sent for a folder with nothing to lose.
  test("uninstallRequest: force only where there is unsaved work", () => {
    assert.deepEqual(uninstallRequest({ keepKeys: true, unsaved: [] }), { action: "uninstall", keepKeys: true, force: false });
    assert.deepEqual(uninstallRequest({ keepKeys: false, unsaved: ["stashed changes (1)"] }), {
      action: "uninstall",
      keepKeys: false,
      force: true,
    });
  });

  test("uninstallRefusalMessage: the script's reason, in words, and never a claim it can't make", () => {
    const of = (reason: string | null): string =>
      uninstallRefusalMessage({ removed: false, reason, detail: null, keptKeys: null, leftover: null });
    // The two the script guarantees changed nothing: it moves the folder aside
    // before deleting anything, so a failed move is a retryable no-op.
    assert.match(of("access-denied"), /nothing was deleted/);
    assert.match(of("files-in-use"), /nothing was deleted/);
    assert.match(of("unsaved-work"), /nothing was deleted/);
    // Anything else is not claimed either way.
    assert.match(of("error"), /may still be installed/);
    assert.match(of(null), /may still be installed/);
    for (const reason of ["access-denied", "files-in-use", "unsaved-work", "cancelled", "error", null]) {
      assert.doesNotMatch(of(reason), /was uninstalled/, `${reason} never reports success`);
    }
  });
});
