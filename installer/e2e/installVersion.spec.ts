/**
 * End-to-end: which Granted the install sets up. A release build installs
 * its own release, or — with "Check for and install the latest version"
 * ticked — a newer one from GitHub's latest-release API (here a local stand-in
 * server, via GRANTED_RELEASES_API; the release this build was "made for"
 * comes from GRANTED_RELEASE_TAG). The install itself isn't started: that
 * would run the real published script.
 */
import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { launchInstaller, makeFakeInstall, type FakeInstall } from "./fixtures";

// PRE-EXISTING gap, found while adding macOS e2e coverage in a separate
// task: this file has no platform skip, but the version-pinning it drives
// (ipc.ts's versionPlanner `pinned: process.platform === "win32" ?
// pinnedReleaseTag() : null`) is itself win32-only — a development build on
// any other platform, GRANTED_RELEASE_TAG or not, always gets `pinned:
// null`, so the "Check for and install the latest version" UI these tests
// drive never renders there. Unrelated to macOS's new install-status
// parity; release-pinning staying Windows-only is untouched by that work.
test.skip(process.platform !== "win32", "Release-pin selection (ipc.ts's versionPlanner) is Windows-only so far");

let install: FakeInstall;
let app: ElectronApplication | undefined;
let page: Page;
let releases: Server | undefined;
let requests = 0;

/** A stand-in for api.github.com/repos/…/releases/latest: answers `status` with `body`. */
async function serveLatest(status: number, body: unknown): Promise<string> {
  requests = 0;
  releases = createServer((_req, res) => {
    requests++;
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  });
  await new Promise<void>((r) => releases!.listen(0, "127.0.0.1", () => r()));
  return `http://127.0.0.1:${(releases.address() as AddressInfo).port}/releases/latest`;
}

async function openCheckScreen(env: Record<string, string>): Promise<void> {
  ({ app, page } = await launchInstaller(install, env));
  await page.getByRole("button", { name: "Get Started" }).click();
  await page.getByRole("heading", { name: "Checking your computer" }).waitFor();
}

const note = (): ReturnType<Page["getByTestId"]> => page.getByTestId("install-version");
const updatesBox = (): ReturnType<Page["getByLabel"]> => page.getByLabel("Check for and install the latest version of Granted");

test.beforeEach(() => {
  install = makeFakeInstall();
});

test.afterEach(async () => {
  await app?.close().catch(() => {});
  app = undefined;
  releases?.close();
  releases = undefined;
  install?.cleanup();
});

test("a newer release on GitHub: ticked by default, it installs that one; unticked, this installer's own", async () => {
  const api = await serveLatest(200, { tag_name: "v0.2.0", draft: false, prerelease: false });
  await openCheckScreen({ GRANTED_RELEASE_TAG: "v0.1.0", GRANTED_RELEASES_API: api });
  await expect(updatesBox()).toBeChecked();
  await expect(note()).toHaveText("A newer version is available: Granted v0.2.0 will be installed.");
  await updatesBox().uncheck();
  await expect(note()).toHaveText("Granted v0.1.0 (this installer's version) will be installed.");
  await updatesBox().check();
  await expect(note()).toHaveText(/Granted v0\.2\.0 will be installed/);
  expect(requests, "GitHub is asked once, not on every tick").toBe(1);
});

test("already the latest: says so", async () => {
  const api = await serveLatest(200, { tag_name: "v0.1.0" });
  await openCheckScreen({ GRANTED_RELEASE_TAG: "v0.1.0", GRANTED_RELEASES_API: api });
  await expect(note()).toHaveText("Granted v0.1.0 is the latest version.");
});

test("an older, prerelease or non-version 'latest' never downgrades or side-grades", async () => {
  for (const body of [{ tag_name: "v0.0.9" }, { tag_name: "v9.0.0", prerelease: true }, { tag_name: "hackathon-deadline" }]) {
    const api = await serveLatest(200, body);
    await openCheckScreen({ GRANTED_RELEASE_TAG: "v0.1.0", GRANTED_RELEASES_API: api });
    await expect(note(), JSON.stringify(body)).toHaveText("Granted v0.1.0 is the latest version.");
    await app?.close();
    app = undefined;
    releases?.close();
    releases = undefined;
  }
});

test("GitHub can't be reached: says so, and installs this installer's version", async () => {
  const api = await serveLatest(500, { message: "nope" });
  await openCheckScreen({ GRANTED_RELEASE_TAG: "v0.1.0", GRANTED_RELEASES_API: api });
  await expect(note()).toHaveText("Couldn't check for updates, so Granted v0.1.0 (this installer's version) will be installed.");
  await expect(page.getByRole("button", { name: /Continue with installing|Open a terminal/ })).toBeEnabled();
});

test("a development build (no release) offers no update check: it installs main, as before", async () => {
  await openCheckScreen({ GRANTED_RELEASE_TAG: "" });
  await expect(page.getByRole("button", { name: /Continue with installing|Open a terminal/ })).toBeEnabled();
  await expect(updatesBox()).toHaveCount(0);
});
