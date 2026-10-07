import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { handleUninstallGet, handleUninstallPost, resetUninstallStateForTests, type UninstallDeps } from "../handler";
import type { UninstallCheck, UninstallChoice, UninstallOutcome } from "@/lib/appUpdate/install";

const SCRIPT = "/Users/a/granted/scaffold/scripts/macos/uninstall.sh";

/** A world for the handler: everything it touches, recorded. */
function world(
  over: {
    canUninstall?: boolean;
    reason?: "not-macos" | "not-installer-made" | "no-uninstaller";
    check?: UninstallCheck | null;
    loopback?: boolean;
    startFails?: boolean;
    /** What the started uninstaller has written to its log so far. */
    outcome?: UninstallOutcome | null;
    /** The clock, so a latch left behind by a refused uninstall can be aged. */
    clock?: { now: number };
    deps?: Partial<UninstallDeps>;
  } = {},
) {
  const calls = { checks: 0, outcomes: 0, started: [] as Array<[string, UninstallChoice]> };
  const can = over.canUninstall !== false;
  const clock = over.clock ?? { now: 1_760_000_000_000 };
  const deps: Partial<UninstallDeps> = {
    isLoopbackRequest: () => over.loopback ?? true,
    uninstallInfo: () => ({
      installDir: "/Users/a/granted",
      canUninstall: can,
      reason: can ? null : (over.reason ?? "not-macos"),
      script: can ? SCRIPT : null,
    }),
    readUninstallCheck: async () => {
      calls.checks++;
      return over.check === undefined
        ? {
            installDir: "/Users/a/granted",
            grantedInstall: true,
            installerMade: true,
            unsaved: [],
            keyFiles: ["/Users/a/granted/scaffold/.env.local"],
            backupDir: "/Users/a/Documents/Granted backup 2026-10-06 1200",
          }
        : over.check;
    },
    startUninstaller: async (script, choice) => {
      calls.started.push([script, choice]);
      if (over.startFails) throw new Error("no bash");
      return "/tmp/granted-uninstall.log";
    },
    readUninstallOutcome: () => {
      calls.outcomes++;
      return over.outcome ?? null;
    },
    now: () => clock.now,
    ...over.deps,
  };
  return { deps, calls, clock };
}

const refusal = (reason: string): UninstallOutcome => ({
  removed: false,
  reason,
  detail: "mv: rename /Users/a/granted: Permission denied",
  keptKeys: null,
  leftover: null,
});

const getReq = (query = "") => ({ headers: { get: () => null }, url: `http://127.0.0.1:3000/api/app/uninstall${query}` });
const postReq = (body: unknown) => ({ headers: { get: () => null }, json: async () => body });

beforeEach(() => resetUninstallStateForTests());

describe("GET /api/app/uninstall", () => {
  test("what would be deleted, and what the page has to warn about", async () => {
    const w = world({
      check: {
        installDir: "/Users/a/granted",
        grantedInstall: true,
        installerMade: true,
        unsaved: ["changed or new files (3)"],
        keyFiles: ["/Users/a/granted/scaffold/.env.local"],
        backupDir: "/Users/a/Documents/Granted backup 2026-10-06 1200",
      },
    });
    const info = await (await handleUninstallGet(getReq(), w.deps)).json();
    assert.equal(info.canUninstall, true);
    assert.equal(info.installDir, "/Users/a/granted");
    assert.deepEqual(info.unsaved, ["changed or new files (3)"]);
    assert.deepEqual(info.keyFiles, ["/Users/a/granted/scaffold/.env.local"]);
    assert.match(info.backupDir, /Granted backup/);
    assert.equal(w.calls.checks, 1, "the script is asked, not second-guessed here");
  });

  test("a copy that can't uninstall itself says so, and the script is never run", async () => {
    for (const reason of ["not-macos", "not-installer-made", "no-uninstaller"] as const) {
      const w = world({ canUninstall: false, reason });
      const info = await (await handleUninstallGet(getReq(), w.deps)).json();
      assert.equal(info.canUninstall, false);
      assert.equal(info.reason, reason);
      assert.deepEqual(info.unsaved, []);
      assert.equal(w.calls.checks, 0);
    }
  });

  test("a script that answers nothing readable means no button, not a guess", async () => {
    const info = await (await handleUninstallGet(getReq(), world({ check: null }).deps)).json();
    assert.equal(info.canUninstall, false);
    assert.equal(info.reason, "no-uninstaller");
  });

  test("a folder the installer didn't make is refused even when the script is there", async () => {
    const w = world({
      check: {
        installDir: "/Users/a/own-checkout",
        grantedInstall: true,
        installerMade: false,
        unsaved: [],
        keyFiles: [],
        backupDir: "/b",
      },
    });
    const info = await (await handleUninstallGet(getReq(), w.deps)).json();
    assert.equal(info.canUninstall, false);
    assert.equal(info.reason, "not-installer-made");
  });

  test("only from this computer", async () => {
    assert.equal((await handleUninstallGet(getReq(), world({ loopback: false }).deps)).status, 403);
  });
});

describe("POST /api/app/uninstall", () => {
  test("starts the uninstaller with --quiet and the keep-keys choice", async () => {
    const w = world();
    const res = await handleUninstallPost(postReq({ action: "uninstall", keepKeys: true }), w.deps);
    assert.equal(res.status, 202);
    const body = await res.json();
    assert.equal(body.started, true);
    assert.match(body.keptKeys, /Granted backup/);
    assert.deepEqual(w.calls.started, [[SCRIPT, { keepKeys: true, force: false }]]);
  });

  // A started uninstall is never un-started within one server (see the
  // "already running" test below), so each attempt here gets a fresh one.
  test("keepKeys defaults to keeping them: only an explicit false turns it off", async () => {
    const kept = world();
    await handleUninstallPost(postReq({ action: "uninstall" }), kept.deps);
    assert.deepEqual(kept.calls.started[0][1], { keepKeys: true, force: false });

    resetUninstallStateForTests();
    const not = world();
    const res = await handleUninstallPost(postReq({ action: "uninstall", keepKeys: false }), not.deps);
    assert.deepEqual(not.calls.started[0][1], { keepKeys: false, force: false });
    assert.equal((await res.json()).keptKeys, null, "and the answer doesn't claim a copy was kept");
  });

  // The rule the Windows script enforces with -Quiet and -Force, enforced here
  // because the page is the thing doing the asking.
  test("unsaved work is refused (409, and what it is) unless force says it was shown and accepted", async () => {
    const dirty = {
      installDir: "/Users/a/granted",
      grantedInstall: true,
      installerMade: true,
      unsaved: ["changed or new files (2)", "commits that aren't pushed (1)"],
      keyFiles: [],
      backupDir: "/b",
    };
    const refused = world({ check: dirty });
    const res = await handleUninstallPost(postReq({ action: "uninstall" }), refused.deps);
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.equal(body.started, false);
    assert.deepEqual(body.unsaved, dirty.unsaved);
    assert.deepEqual(refused.calls.started, [], "nothing was started");

    const forced = world({ check: dirty });
    const ok = await handleUninstallPost(postReq({ action: "uninstall", force: true }), forced.deps);
    assert.equal(ok.status, 202);
    assert.deepEqual(forced.calls.started, [[SCRIPT, { keepKeys: true, force: true }]]);
  });

  test("the unsaved work is read again here, so a page left open can't delete it on a stale answer", async () => {
    // The page was rendered when the folder was clean; by the time Uninstall
    // was pressed it wasn't.
    const w = world({
      check: {
        installDir: "/Users/a/granted",
        grantedInstall: true,
        installerMade: true,
        unsaved: ["changed or new files (1)"],
        keyFiles: [],
        backupDir: "/b",
      },
    });
    const res = await handleUninstallPost(postReq({ action: "uninstall", keepKeys: true }), w.deps);
    assert.equal(res.status, 409);
    assert.equal(w.calls.checks, 1);
    assert.deepEqual(w.calls.started, []);
  });

  test("a copy that can't uninstall itself, and a folder the installer didn't make, are both 409", async () => {
    const cannot = world({ canUninstall: false, reason: "not-macos" });
    const res = await handleUninstallPost(postReq({ action: "uninstall" }), cannot.deps);
    assert.equal(res.status, 409);
    assert.equal((await res.json()).reason, "not-macos");
    assert.deepEqual(cannot.calls.started, []);

    const notOurs = world({
      check: { installDir: "/Users/a/own", grantedInstall: true, installerMade: false, unsaved: [], keyFiles: [], backupDir: "/b" },
    });
    const second = await handleUninstallPost(postReq({ action: "uninstall" }), notOurs.deps);
    assert.equal(second.status, 409);
    assert.deepEqual(notOurs.calls.started, []);
  });

  test("a second uninstall while one is running is refused", async () => {
    const w = world();
    assert.equal((await handleUninstallPost(postReq({ action: "uninstall" }), w.deps)).status, 202);
    const again = await handleUninstallPost(postReq({ action: "uninstall" }), w.deps);
    assert.equal(again.status, 409);
    assert.match((await again.json()).error, /already running/);
    assert.equal(w.calls.started.length, 1);
  });

  // REGRESSION (review): the script is only SPAWNED when this answers 202, and
  // it can still refuse afterwards — exit 3 for a parent folder it can't write
  // to leaves the install whole and Granted running. The latch used to be
  // cleared only by an immediate spawn error, so every later attempt got
  // "already running" until the whole server was restarted: no way to retry.
  test("an uninstaller that refused can be retried at once: its log says so, and the latch goes", async () => {
    const started = world();
    assert.equal((await handleUninstallPost(postReq({ action: "uninstall" }), started.deps)).status, 202);

    // The script has now written its refusal (exit 3) to the log.
    const refused = world({ outcome: refusal("access-denied") });
    const info = await (await handleUninstallGet(getReq("?check=0"), refused.deps)).json();
    assert.equal(info.running, false, "not running any more");
    assert.equal(info.outcome.removed, false);
    assert.equal(info.outcome.reason, "access-denied");
    assert.equal(refused.calls.checks, 0, "?check=0 doesn't run the script to answer this");

    // And a second attempt goes ahead, in the same server.
    const retry = await handleUninstallPost(postReq({ action: "uninstall" }), world().deps);
    assert.equal(retry.status, 202);
    assert.equal((await retry.json()).started, true);
  });

  // The other half: a script that reports nothing at all (its log was never
  // written, the Mac went to sleep…). A latch nothing clears is a lockout, so
  // it ages out.
  test("a latch nothing ever reported on goes stale, and a later attempt is allowed", async () => {
    const clock = { now: 1_760_000_000_000 };
    const w = world({ clock });
    assert.equal((await handleUninstallPost(postReq({ action: "uninstall" }), w.deps)).status, 202);

    clock.now += 4 * 60 * 1000;
    const tooSoon = await handleUninstallPost(postReq({ action: "uninstall" }), world({ clock }).deps);
    assert.equal(tooSoon.status, 409, "four minutes in, it really might still be running");
    assert.equal((await (await handleUninstallGet(getReq("?check=0"), world({ clock }).deps)).json()).running, true);

    clock.now += 2 * 60 * 1000;
    const after = await handleUninstallPost(postReq({ action: "uninstall" }), world({ clock }).deps);
    assert.equal(after.status, 202, "past the staleness window it is not believed any more");
    assert.equal((await after.json()).started, true);
  });

  test("nothing started: GET reports no uninstall running and no outcome, and ?check=0 asks the script nothing", async () => {
    const w = world();
    const info = await (await handleUninstallGet(getReq("?check=0"), w.deps)).json();
    assert.equal(info.running, false);
    assert.equal(info.outcome, null);
    assert.equal(w.calls.checks, 0);
    // The full GET still does ask it.
    const full = world();
    assert.equal((await (await handleUninstallGet(getReq(), full.deps)).json()).canUninstall, true);
    assert.equal(full.calls.checks, 1);
  });

  test("an uninstaller that couldn't be started is reported, and another attempt is allowed", async () => {
    const broken = world({ startFails: true });
    const res = await handleUninstallPost(postReq({ action: "uninstall" }), broken.deps);
    assert.equal(res.status, 500);
    const body = await res.json();
    assert.equal(body.started, false);
    assert.match(body.error, /Couldn't start the uninstaller/);
    assert.equal(typeof body.errorId, "string");
    // Not stuck on "already running" after a failure to launch.
    assert.equal((await handleUninstallPost(postReq({ action: "uninstall" }), world().deps)).status, 202);
  });

  test("an unknown action, and a request from anywhere but this computer, start nothing", async () => {
    const unknown = world();
    assert.equal((await handleUninstallPost(postReq({ action: "please-delete" }), unknown.deps)).status, 400);
    assert.deepEqual(unknown.calls.started, []);
    const remote = world({ loopback: false });
    assert.equal((await handleUninstallPost(postReq({ action: "uninstall" }), remote.deps)).status, 403);
    assert.deepEqual(remote.calls.started, []);
  });
});
