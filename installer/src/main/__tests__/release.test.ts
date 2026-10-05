import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  buildWindowsInstallScript,
  chooseInstallRef,
  isNewerRelease,
  parseLatestRelease,
  parseReleaseTag,
  windowsInstallCommand,
} from "../ipcPure";
import { createVersionPlanner, fetchLatestReleaseTag, pinnedReleaseTag } from "../release";

describe("release tags", () => {
  test("only v<major>.<minor>.<patch> is a release tag", () => {
    assert.deepEqual(parseReleaseTag("v1.2.3"), [1, 2, 3]);
    assert.deepEqual(parseReleaseTag("v10.0.12"), [10, 0, 12]);
    for (const bad of ["1.2.3", "v1.2", "v1.2.3-beta", "hackathon-deadline", "main", "", null, undefined, "v1.2.3; rm -rf /"]) {
      assert.equal(parseReleaseTag(bad), null, String(bad));
    }
  });

  test("isNewerRelease compares numerically, not as text", () => {
    assert.equal(isNewerRelease("v0.10.0", "v0.9.9"), true);
    assert.equal(isNewerRelease("v1.0.0", "v0.99.99"), true);
    assert.equal(isNewerRelease("v0.1.1", "v0.1.0"), true);
    assert.equal(isNewerRelease("v0.1.0", "v0.1.0"), false);
    assert.equal(isNewerRelease("v0.0.9", "v0.1.0"), false);
    assert.equal(isNewerRelease("hackathon-deadline", "v0.1.0"), false);
    assert.equal(isNewerRelease(null, "v0.1.0"), false);
  });

  test("parseLatestRelease takes only a published, stable release tag", () => {
    assert.equal(parseLatestRelease({ tag_name: "v0.2.0", draft: false, prerelease: false }), "v0.2.0");
    assert.equal(parseLatestRelease({ tag_name: "v0.2.0", prerelease: true }), null);
    assert.equal(parseLatestRelease({ tag_name: "v0.2.0", draft: true }), null);
    assert.equal(parseLatestRelease({ tag_name: "hackathon-deadline" }), null);
    assert.equal(parseLatestRelease({ message: "Not Found" }), null);
    assert.equal(parseLatestRelease(null), null);
    assert.equal(parseLatestRelease("v0.2.0"), null);
  });
});

describe("chooseInstallRef", () => {
  test("a development build (nothing pinned) installs main, and never checks", () => {
    assert.deepEqual(chooseInstallRef({ pinned: null, checkForUpdates: true, latest: "v9.0.0", checkFailed: false }), {
      pinned: null,
      latest: null,
      ref: null,
      checkForUpdates: false,
      checkFailed: false,
    });
  });

  test("checking for updates: a newer release wins; the same, an older or none keeps this installer's own", () => {
    const pick = (latest: string | null): string | null => chooseInstallRef({ pinned: "v0.2.0", checkForUpdates: true, latest, checkFailed: false }).ref;
    assert.equal(pick("v0.3.0"), "v0.3.0");
    assert.equal(pick("v0.2.0"), "v0.2.0");
    assert.equal(pick("v0.1.0"), "v0.2.0", "never a downgrade");
    assert.equal(pick(null), "v0.2.0");
  });

  test("not checking: always this installer's own release", () => {
    const plan = chooseInstallRef({ pinned: "v0.2.0", checkForUpdates: false, latest: "v0.3.0", checkFailed: false });
    assert.equal(plan.ref, "v0.2.0");
    assert.equal(plan.latest, null);
  });

  test("a failed check is reported, and falls back to this installer's own release", () => {
    const plan = chooseInstallRef({ pinned: "v0.2.0", checkForUpdates: true, latest: null, checkFailed: true });
    assert.equal(plan.ref, "v0.2.0");
    assert.equal(plan.checkFailed, true);
  });
});

describe("the Windows install command", () => {
  test("main for a development build: the README's one-liner", () => {
    assert.equal(windowsInstallCommand(null), "irm https://raw.githubusercontent.com/KurtLehnardt/granted/main/install-windows.ps1 | iex");
  });

  test("a release: that tag's script, told (GRANTED_REF) to install that tag", () => {
    assert.equal(
      windowsInstallCommand("v0.2.0"),
      "$env:GRANTED_REF = 'v0.2.0'; irm https://raw.githubusercontent.com/KurtLehnardt/granted/v0.2.0/install-windows.ps1 | iex",
    );
  });

  test("anything that isn't a release tag is refused, never spliced into a command", () => {
    assert.throws(() => windowsInstallCommand("v1.0.0'; Remove-Item C:\\ -Recurse; '"));
    assert.throws(() => windowsInstallCommand("main"));
  });

  test("the temp script reports to the status file first, then runs the command", () => {
    const script = buildWindowsInstallScript("C:\\Temp\\it's.json", "v0.2.0");
    assert.equal(script, `$env:GRANTED_STATUS_FILE = 'C:\\Temp\\it''s.json'\r\n${windowsInstallCommand("v0.2.0")}\r\n`);
  });
});

describe("the update check against a real HTTP server", () => {
  const servers: Server[] = [];
  after(() => servers.forEach((s) => s.close()));
  async function serve(status: number, body: unknown, delayMs = 0): Promise<{ url: string; hits: () => number }> {
    let hits = 0;
    const server = createServer((_req, res) => {
      hits++;
      setTimeout(() => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(body));
      }, delayMs);
    });
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`, hits: () => hits };
  }

  test("reads the latest tag; 404 (no releases yet) is not a failure; 5xx and timeouts are", async () => {
    assert.deepEqual(await fetchLatestReleaseTag((await serve(200, { tag_name: "v1.0.0" })).url, 2000), { tag: "v1.0.0", failed: false });
    assert.deepEqual(await fetchLatestReleaseTag((await serve(404, { message: "Not Found" })).url, 2000), { tag: null, failed: false });
    assert.deepEqual(await fetchLatestReleaseTag((await serve(503, {})).url, 2000), { tag: null, failed: true });
    assert.deepEqual(await fetchLatestReleaseTag((await serve(200, {}, 1500)).url, 200), { tag: null, failed: true });
    assert.deepEqual(await fetchLatestReleaseTag("http://127.0.0.1:1/", 2000), { tag: null, failed: true });
  });

  test("the planner asks GitHub once per run after a success, and retries after a failure", async () => {
    const ok = await serve(200, { tag_name: "v0.3.0" });
    const planner = createVersionPlanner({ pinned: "v0.2.0", latestUrl: ok.url });
    assert.equal((await planner.plan(true)).ref, "v0.3.0");
    assert.equal((await planner.plan(false)).ref, "v0.2.0");
    assert.equal((await planner.plan(true)).ref, "v0.3.0");
    assert.equal(ok.hits(), 1);

    const failing = await serve(500, {});
    const retrying = createVersionPlanner({ pinned: "v0.2.0", latestUrl: failing.url });
    assert.equal((await retrying.plan(true)).checkFailed, true);
    await retrying.plan(true);
    assert.equal(failing.hits(), 2);
  });

  test("REGRESSION (review): the install uses what the screen last showed, never a fresh check", async () => {
    const ok = await serve(200, { tag_name: "v0.3.0" });
    const planner = createVersionPlanner({ pinned: "v0.2.0", latestUrl: ok.url });
    // Before the screen planned: no newer release is assumed (and nothing is fetched).
    assert.deepEqual(planner.current(true), { pinned: "v0.2.0", latest: null, ref: "v0.2.0", checkForUpdates: true, checkFailed: true });
    assert.equal(ok.hits(), 0);
    await planner.plan(true);
    assert.equal(planner.current(true).ref, "v0.3.0", "what the screen showed");
    assert.equal(planner.current(false).ref, "v0.2.0", "unticked: this installer's own");
    assert.equal(ok.hits(), 1);
  });

  test("a failed check shown on screen stays the plan for the install", async () => {
    const failing = await serve(500, {});
    const planner = createVersionPlanner({ pinned: "v0.2.0", latestUrl: failing.url });
    assert.equal((await planner.plan(true)).checkFailed, true);
    assert.equal(planner.current(true).ref, "v0.2.0");
    assert.equal(failing.hits(), 1, "current() never retries behind the screen's back");
  });

  test("pinnedReleaseTag: GRANTED_RELEASE_TAG when it's a release tag, else none (a dev build has nothing baked in)", () => {
    assert.equal(pinnedReleaseTag({ GRANTED_RELEASE_TAG: "v1.2.3" }), "v1.2.3");
    assert.equal(pinnedReleaseTag({ GRANTED_RELEASE_TAG: "nightly" }), null);
    assert.equal(pinnedReleaseTag({}), null);
  });
});
