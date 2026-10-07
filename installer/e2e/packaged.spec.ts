/**
 * Smoke test of the PACKAGED installer (what a release ships): the
 * electron-builder output, not the dev build. Run after `npm run dist`
 * (Windows) or `npm run dist:mac` (macOS) with
 *   GRANTED_PACKAGED_EXE=dist\win-unpacked\Granted Setup.exe
 *   GRANTED_PACKAGED_EXE=dist/mac-arm64/Granted Setup.app
 *   GRANTED_EXPECT_TAG=<the GRANTED_RELEASE_TAG it was built with>
 * (the release workflow and CI do). Proves the app starts from the package,
 * shows its screens, and has its release baked in — the tag isn't passed at
 * runtime here.
 *
 * On macOS the variable may name either the `.app` bundle or the binary
 * inside it; the bundle is what electron-builder produces and what a user
 * double-clicks, so that is what the workflows pass.
 */
import { test, expect, _electron as electron, type ElectronApplication } from "@playwright/test";
import { createServer, type Server } from "node:http";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { INSTALLER_ROOT, makeFakeInstall, type FakeInstall } from "./fixtures";

const packaged = process.env["GRANTED_PACKAGED_EXE"];
const expectTag = process.env["GRANTED_EXPECT_TAG"];

test.skip(!packaged || !expectTag, "Set GRANTED_PACKAGED_EXE and GRANTED_EXPECT_TAG to smoke-test a packaged build");

/**
 * The binary Playwright has to launch. A macOS `.app` is a folder, so the
 * executable inside it is what `electron.launch` needs; everywhere else the
 * path already is the executable. The bundle's own CFBundleExecutable names
 * it, rather than this guessing from the product name, because
 * electron-builder derives that name itself.
 */
function executableOf(appPath: string): string {
  if (!appPath.endsWith(".app") || !statSync(appPath).isDirectory()) return appPath;
  const name = execFileSync("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleExecutable", join(appPath, "Contents", "Info.plist")], {
    encoding: "utf8",
  }).trim();
  return join(appPath, "Contents", "MacOS", name);
}

let app: ElectronApplication | undefined;
let releases: Server | undefined;
let install: FakeInstall | undefined;

test.afterEach(async () => {
  await app?.close().catch(() => {});
  releases?.close();
  install?.cleanup();
});

// Windows only, for two separate reasons, both deliberate:
//
//  1. The "Check for and install the latest version of Granted" UI this
//     drives is win32-only. ipc.ts builds its versionPlanner with
//     `pinned: process.platform === "win32" ? pinnedReleaseTag() : null`, so
//     on macOS the screen gets `pinned: null` and never renders the box or
//     the note — the same pre-existing gap e2e/installVersion.spec.ts skips
//     itself for. The tag IS baked into the macOS build (release.ts reads the
//     same `__GRANTED_RELEASE_TAG__`); only the pick-a-release UI is missing.
//  2. A PACKAGED macOS app cannot have its Terminal launch stubbed. The
//     darwin branch of openInstallTerminal writes a temp script and hands it
//     to Terminal via AppleScript; there is no injectable launcher (which is
//     why e2e/macInstall.spec.ts delivers the install's "done" event directly
//     instead of going through it). Driving this screen's primary button in a
//     packaged build would therefore start a REAL install on whatever machine
//     the test runs on. The macOS test below stays on the Welcome screen for
//     exactly that reason.
test("the packaged installer starts, and installs its own baked-in release (or a newer one when asked)", async () => {
  test.skip(process.platform !== "win32", "The release-pinning UI this drives is Windows-only (see above)");
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
  app = await electron.launch({ executablePath: executableOf(packaged!), env });
  const page = await app.firstWindow();
  await page.getByRole("button", { name: "Get Started" }).click();
  await page.getByRole("heading", { name: "Checking your computer" }).waitFor();
  const note = page.getByTestId("install-version");
  await expect(note).toHaveText("A newer version is available: Granted v999.0.0 will be installed.");
  await page.getByLabel("Check for and install the latest version of Granted").uncheck();
  await expect(note).toHaveText(`Granted ${expectTag} (this installer's version) will be installed.`);
});

// The macOS half: the packaged .app really starts and draws its first screen.
// It stops there on purpose — see reason 2 above. Going further in a packaged
// build risks a real install, and a release smoke test must not be able to
// install Granted onto the machine that is testing it.
test("the packaged macOS app starts and shows its first screen", async () => {
  test.skip(process.platform !== "darwin", "macOS only");
  install = makeFakeInstall();
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    GRANTED_INSTALL_DIR: install.installDir,
    // Nothing listens on port 9: the release check can't reach the real
    // GitHub API from a smoke test.
    GRANTED_RELEASES_API: "http://127.0.0.1:9/",
  };
  delete env["GRANTED_RELEASE_TAG"]; // the baked-in tag must be what's used
  app = await electron.launch({ executablePath: executableOf(packaged!), env });
  const page = await app.firstWindow();
  await expect(page.getByRole("button", { name: "Get Started" })).toBeVisible();
  // Which build this is. Checked against package.json rather than against
  // GRANTED_EXPECT_TAG, because those two are only equal on a release build:
  // ci.yml packages with a stand-in tag (v0.0.0) to prove packaging works at
  // all. On a real release they ARE equal — release.yml refuses to build
  // unless the tag matches both package.json versions — so on the .dmg that
  // actually gets uploaded this does tie the bundle to its release.
  const version = JSON.parse(readFileSync(join(INSTALLER_ROOT, "package.json"), "utf8")).version as string;
  expect(await app.evaluate(({ app: electronApp }) => electronApp.getVersion())).toBe(version);
});

// The .app bundle a user actually drags out of the .dmg. Checked separately
// from "it starts" because a bundle can start on this developer's Mac and
// still be wrong for everyone else: an x86_64 slice would launch under
// Rosetta (which the release deliberately does not ship), and a bundle whose
// identifier or icon is missing is one macOS treats as a different app on
// every build.
test("the packaged macOS app is a native arm64 bundle with its identity set", async () => {
  test.skip(process.platform !== "darwin", "macOS only");
  test.skip(!packaged!.endsWith(".app"), "Point GRANTED_PACKAGED_EXE at the .app bundle to check it");

  const plist = (key: string): string =>
    execFileSync("/usr/libexec/PlistBuddy", ["-c", `Print :${key}`, join(packaged!, "Contents", "Info.plist")], { encoding: "utf8" }).trim();

  // Native Apple Silicon, with no x86_64 slice to fall back to Rosetta.
  const archs = execFileSync("/usr/bin/lipo", ["-archs", executableOf(packaged!)], { encoding: "utf8" }).trim().split(/\s+/);
  expect(archs).toEqual(["arm64"]);

  expect(plist("CFBundleIdentifier")).toBe("io.github.kurtlehnardt.granted.setup");
  expect(plist("CFBundleName")).toBe("Granted Setup");
  const resources = readdirSync(join(packaged!, "Contents", "Resources"));
  // The icon electron-builder converted from the repo's own granted.ico.
  expect(resources).toContain(plist("CFBundleIconFile"));
  // The wizard's own code, not just an unmodified Electron shell.
  expect(resources).toContain("app.asar");
});
