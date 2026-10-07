import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  AUTO_CHECK_INTERVAL_MS,
  autoCheckDue,
  handleUpdateGet,
  handleUpdatePost,
  requestPort,
  resetUpdateCacheForTests,
  type UpdateDeps,
} from "../handler";
import type { UpdateSettings, UpdateStatus } from "@/lib/appUpdate/install";

/** A world for the handler: everything it touches, recorded. */
function world(over: {
  version?: string;
  latest?: string | null;
  failed?: boolean;
  canUpdate?: boolean;
  settings?: UpdateSettings;
  status?: UpdateStatus | null;
  now?: number;
  loopback?: boolean;
  launchFails?: boolean;
  deps?: Partial<UpdateDeps>;
} = {}) {
  const calls = { fetches: 0, started: [] as Array<[string, number]>, writes: [] as Array<Partial<UpdateSettings>>, statuses: [] as UpdateStatus[] };
  let status: UpdateStatus | null = over.status ?? null;
  let settings: UpdateSettings = over.settings ?? { autoUpdate: false, lastAutoCheck: null };
  const deps: Partial<UpdateDeps> = {
    isLoopbackRequest: () => over.loopback ?? true,
    appVersion: () => over.version ?? "0.1.1",
    installInfo: () =>
      over.canUpdate === false
        ? { installDir: "C:\\g", canUpdate: false, reason: "not-installer-made", script: null }
        : { installDir: "C:\\g", canUpdate: true, reason: null, script: "C:\\g\\scaffold\\scripts\\windows\\update.ps1" },
    readUpdateSettings: () => settings,
    writeUpdateSettings: (c) => {
      calls.writes.push(c);
      settings = { ...settings, ...c };
    },
    readUpdateStatus: () => status,
    writeUpdateStatus: (s) => {
      calls.statuses.push(s);
      status = s;
    },
    fetchLatest: async () => {
      calls.fetches++;
      return { tag: over.latest === undefined ? "v0.2.0" : over.latest, failed: over.failed ?? false };
    },
    startUpdater: async (ref, port) => {
      calls.started.push([ref, port]);
      if (over.launchFails) throw new Error("no PowerShell");
    },
    now: () => over.now ?? 1_000_000_000_000,
    port: () => 3000,
    ...over.deps,
  };
  return { deps, calls, settings: () => settings };
}

const getReq = (query = "") => ({ headers: { get: () => null }, url: `http://127.0.0.1:3000/api/app/update${query}` });
const postReq = (body: unknown) => ({ headers: { get: () => null }, json: async () => body });

beforeEach(() => resetUpdateCacheForTests());

describe("GET /api/app/update", () => {
  test("the version and, when checking, whether a newer release exists", async () => {
    const w = world();
    const info = await (await handleUpdateGet(getReq("?check=force"), w.deps)).json();
    assert.equal(info.version, "0.1.1");
    assert.equal(info.latest, "v0.2.0");
    assert.equal(info.updateAvailable, true);
    assert.equal(info.canUpdate, true);
    assert.equal(info.autoUpdate, false);
  });

  test("?check=0 (opening Settings, polling during an update) never asks GitHub", async () => {
    const w = world();
    const info = await (await handleUpdateGet(getReq("?check=0"), w.deps)).json();
    assert.equal(w.calls.fetches, 0);
    assert.equal(info.updateAvailable, false);
    assert.equal(info.version, "0.1.1");
  });

  test("a successful check is reused briefly; ?check=force always asks", async () => {
    const w = world();
    await handleUpdateGet(getReq("?check=1"), w.deps);
    await handleUpdateGet(getReq("?check=1"), w.deps);
    assert.equal(w.calls.fetches, 1);
    await handleUpdateGet(getReq("?check=force"), w.deps);
    assert.equal(w.calls.fetches, 2);
  });

  test("up to date, and GitHub unreachable, are told apart", async () => {
    const same = await (await handleUpdateGet(getReq("?check=force"), world({ latest: "v0.1.1" }).deps)).json();
    assert.equal(same.updateAvailable, false);
    assert.equal(same.checkFailed, false);
    const offline = await (await handleUpdateGet(getReq("?check=force"), world({ latest: null, failed: true }).deps)).json();
    assert.equal(offline.checkFailed, true);
  });

  test("only from this computer", async () => {
    assert.equal((await handleUpdateGet(getReq(), world({ loopback: false }).deps)).status, 403);
  });
});

describe("POST /api/app/update", () => {
  test("install: starts the updater for the newest release on this server's port", async () => {
    const w = world();
    const res = await handleUpdatePost(postReq({ action: "install" }), w.deps);
    assert.equal(res.status, 202);
    const body = await res.json();
    assert.equal(body.started, true);
    assert.equal(body.to, "v0.2.0");
    assert.equal(body.startedAt, new Date(1_000_000_000_000).toISOString());
    assert.deepEqual(w.calls.started, [["v0.2.0", 3000]]);
  });

  test("install: nothing newer -> nothing started; never a downgrade", async () => {
    for (const latest of ["v0.1.1", "v0.1.0", null]) {
      resetUpdateCacheForTests();
      const w = world({ latest });
      const body = await (await handleUpdatePost(postReq({ action: "install" }), w.deps)).json();
      assert.equal(body.started, false, String(latest));
      assert.equal(w.calls.started.length, 0);
    }
  });

  test("install: refused for a copy that can't update itself (a developer checkout), and while an update runs", async () => {
    const dev = world({ canUpdate: false });
    assert.equal((await handleUpdatePost(postReq({ action: "install" }), dev.deps)).status, 409);
    assert.equal(dev.calls.started.length, 0);

    const busy = world({ status: { state: "running", to: "v0.2.0", at: new Date(1_000_000_000_000 - 60_000).toISOString() } });
    assert.equal((await handleUpdatePost(postReq({ action: "install" }), busy.deps)).status, 409);
    // ...but a "running" left by an updater that died long ago doesn't block forever.
    const stale = world({ status: { state: "running", to: "v0.2.0", at: new Date(1_000_000_000_000 - 3_600_000).toISOString() } });
    assert.equal((await handleUpdatePost(postReq({ action: "install" }), stale.deps)).status, 202);
  });

  test("install: GitHub unreachable -> a clear error, nothing started", async () => {
    const w = world({ latest: null, failed: true });
    assert.equal((await handleUpdatePost(postReq({ action: "install" }), w.deps)).status, 502);
    assert.equal(w.calls.started.length, 0);
  });

  test("settings: turns automatic updates on and off (only where it can update itself)", async () => {
    const w = world();
    assert.deepEqual(await (await handleUpdatePost(postReq({ action: "settings", autoUpdate: true }), w.deps)).json(), { autoUpdate: true });
    assert.equal(w.settings().autoUpdate, true);
    assert.equal((await handleUpdatePost(postReq({ action: "settings", autoUpdate: "yes" }), w.deps)).status, 400);
    assert.equal((await handleUpdatePost(postReq({ action: "settings", autoUpdate: true }), world({ canUpdate: false }).deps)).status, 409);
  });

  test("auto: off by default -> nothing, and GitHub isn't even asked", async () => {
    const w = world();
    assert.deepEqual(await (await handleUpdatePost(postReq({ action: "auto" }), w.deps)).json(), { started: false });
    assert.equal(w.calls.fetches, 0);
  });

  test("auto: on and due -> records the check, updates to the newer release", async () => {
    const w = world({ settings: { autoUpdate: true, lastAutoCheck: null } });
    const body = await (await handleUpdatePost(postReq({ action: "auto" }), w.deps)).json();
    assert.equal(body.started, true);
    assert.deepEqual(w.calls.started, [["v0.2.0", 3000]]);
    assert.equal(w.settings().lastAutoCheck, 1_000_000_000_000);
  });

  test("auto: not again on every page load — only once the interval has passed", async () => {
    const now = 1_000_000_000_000;
    const recent = world({ settings: { autoUpdate: true, lastAutoCheck: now - 60_000 }, now });
    assert.equal((await (await handleUpdatePost(postReq({ action: "auto" }), recent.deps)).json()).started, false);
    assert.equal(recent.calls.fetches, 0);
    assert.equal(autoCheckDue({ autoUpdate: true, canUpdate: true, lastAutoCheck: now - AUTO_CHECK_INTERVAL_MS, now }), true);
    assert.equal(autoCheckDue({ autoUpdate: true, canUpdate: false, lastAutoCheck: null, now }), false);
  });

  test("unknown action -> 400; only from this computer", async () => {
    assert.equal((await handleUpdatePost(postReq({ action: "nope" }), world().deps)).status, 400);
    assert.equal((await handleUpdatePost(postReq({ action: "install" }), world({ loopback: false }).deps)).status, 403);
  });
});

describe("REGRESSION (review): starting an update", () => {
  test("marks the update running BEFORE launching it, so a second click (or the auto check) can't start another", async () => {
    let release!: () => void;
    const w = world({
      deps: {
        startUpdater: () => new Promise<void>((r) => (release = r)),
      },
    });
    const first = handleUpdatePost(postReq({ action: "install" }), w.deps);
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(w.calls.statuses[0]?.state, "running", "written before the updater was even launched");
    assert.equal((await handleUpdatePost(postReq({ action: "install" }), w.deps)).status, 409);
    assert.deepEqual(await (await handleUpdatePost(postReq({ action: "auto" }), w.deps)).json(), { started: false });
    release();
    assert.equal((await first).status, 202);
  });

  test("the updater couldn't be launched -> 500 and an error status, not 'started'", async () => {
    const w = world({ launchFails: true });
    const res = await handleUpdatePost(postReq({ action: "install" }), w.deps);
    assert.equal(res.status, 500);
    assert.match((await res.json()).error, /Couldn't start the update: no PowerShell/);
    assert.equal(w.calls.statuses.at(-1)?.state, "error");
  });

  test("restarts Granted on the port this page uses (Host), else PORT, else 3000", () => {
    const req = (host: string | null) => ({ headers: { get: (n: string) => (n === "host" ? host : null) } });
    assert.equal(requestPort(req("127.0.0.1:3001"), {}), 3001);
    assert.equal(requestPort(req("localhost"), { PORT: "3987" }), 3987);
    assert.equal(requestPort(req(null), {}), 3000);
  });

  test("a 'running' status with a garbled time doesn't block updates forever", async () => {
    const w = world({ status: { state: "running", to: "v0.2.0", at: "not a date" } });
    assert.equal((await handleUpdatePost(postReq({ action: "install" }), w.deps)).status, 202);
  });
});

describe("REGRESSION (review): automatic updates don't nag", () => {
  test("a release that already failed isn't retried automatically (the button still can)", async () => {
    const failed: UpdateStatus = { state: "error", to: "v0.2.0", message: "npm ci failed", at: new Date(0).toISOString() };
    const auto = world({ settings: { autoUpdate: true, lastAutoCheck: null }, status: failed });
    const body = await (await handleUpdatePost(postReq({ action: "auto" }), auto.deps)).json();
    assert.equal(body.started, false);
    assert.equal(auto.calls.started.length, 0);
    resetUpdateCacheForTests();
    const manual = world({ status: failed });
    assert.equal((await handleUpdatePost(postReq({ action: "install" }), manual.deps)).status, 202);
    resetUpdateCacheForTests();
    const newer = world({ settings: { autoUpdate: true, lastAutoCheck: null }, status: failed, latest: "v0.3.0" });
    assert.equal((await (await handleUpdatePost(postReq({ action: "auto" }), newer.deps)).json()).started, true, "a newer release is tried");
  });

  test("on a copy that can't update itself, the page-load check is a quiet 200, not an error", async () => {
    const res = await handleUpdatePost(postReq({ action: "auto" }), world({ canUpdate: false }).deps);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { started: false });
  });
});