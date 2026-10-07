/**
 * Smoke test of the PACKAGED installer (what a release ships): the
 * electron-builder output, not the dev build. Run after `npm run dist` with
 *   GRANTED_PACKAGED_EXE=dist\win-unpacked\Granted Setup.exe
 *   GRANTED_EXPECT_TAG=<the GRANTED_RELEASE_TAG it was built with>
 * (the release workflow and CI do). Proves the app starts from the package,
 * shows its screens, and has its release baked in — the tag isn't passed at
 * runtime here.
 */
import { test, expect, _electron as electron, type ElectronApplication } from "@playwright/test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { makeFakeInstall, type FakeInstall } from "./fixtures";

const exe = process.env["GRANTED_PACKAGED_EXE"];
const expectTag = process.env["GRANTED_EXPECT_TAG"];

test.skip(!exe || !expectTag, "Set GRANTED_PACKAGED_EXE and GRANTED_EXPECT_TAG to smoke-test a packaged build");

let app: ElectronApplication | undefined;
let releases: Server | undefined;
let install: FakeInstall | undefined;

test.afterEach(async () => {
  await app?.close().catch(() => {});
  releases?.close();
  install?.cleanup();
});

test("the packaged installer starts, and installs its own baked-in release (or a newer one when asked)", async () => {
  install = makeFakeInstall();
  releases = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ tag_name: "v999.0.0" }));
  });
  await new Promise<void>((r) => releases!.listen(0, "127.0.0.1", () => r()));
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    GRANTED_INSTALL_DIR: install.installDir,
    GRANTED_RELEASES_API: `http://127.0.0.1:${(releases.address() as AddressInfo).port}/`,
  };
  delete env["GRANTED_RELEASE_TAG"]; // the baked-in tag must be what's used
  app = await electron.launch({ executablePath: exe!, env });
  const page = await app.firstWindow();
  await page.getByRole("button", { name: "Get Started" }).click();
  await page.getByRole("heading", { name: "Checking your computer" }).waitFor();
  const note = page.getByTestId("install-version");
  await expect(note).toHaveText("A newer version is available: Granted v999.0.0 will be installed.");
  await page.getByLabel("Check for and install the latest version of Granted").uncheck();
  await expect(note).toHaveText(`Granted ${expectTag} (this installer's version) will be installed.`);
});
