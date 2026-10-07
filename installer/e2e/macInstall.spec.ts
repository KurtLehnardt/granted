/**
 * End-to-end: the built installer app on macOS, driven through its real UI,
 * reaching "Installation complete" (the install-status event win32 already
 * covers in openGranted.spec.ts, now also real on darwin) and then running
 * a FAKE Granted install's `npm run dev` / `npm run setup:local` for real —
 * both macOS paths: the plain detached launchMacScaffoldTask one (an install
 * with no scripts/macos) and, for an install that has it, the real
 * granted-tray.sh background one, where launchd runs the server under a
 * throwaway LaunchAgent label. No menu-bar icon is started here (fixtures.ts
 * sets GRANTED_MENUBAR_HELPER=none: a test must not put an icon on the
 * machine's menu bar) — the Swift helper itself is covered by
 * macTray.integration.test.ts. The Terminal-launch
 * call itself (openInstallTerminal's darwin branch) is never exercised here,
 * same as openGranted.spec.ts never exercises win32's real PowerShell
 * launch: reachInstallComplete delivers the install's "done" event directly,
 * so no real Terminal window opens during this run either. macOS only.
 */
import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  GRANTED_HTML,
  TEST_PORT,
  TEST_URL,
  appWindowUrls,
  launchInstaller,
  makeFakeInstall,
  openedUrls,
  reachInstallComplete,
  serveOnTestPort,
  stopTestLaunchAgent,
  testPortIsFree,
  type FakeInstall,
} from "./fixtures";

test.skip(process.platform !== "darwin", "This file exercises the macOS-only launchMacScaffoldTask path");

let install: FakeInstall;
let app: ElectronApplication | undefined;
let page: Page;

/**
 * Kills any stand-in fake-dev.js/fake-setup-local.js process tree (npm + the
 * node it spawns) left over from a test. The macOS equivalent of fixtures.ts's
 * killTestStandIns/killWindowsOpenedSince/closeEverything, none of which can
 * be reused here — they shell out to powershell.exe/taskkill.exe, which
 * don't exist on macOS and would throw rather than silently no-op.
 */
function killStandIns(): void {
  try {
    execFileSync("pkill", ["-9", "-f", "fake-(dev|setup-local)\\.js"]);
  } catch {
    /* nothing matched */
  }
}

/** app.close(), falling back to killing the process outright if it hangs (launchMacScaffoldTask's detached child can hold stdio open). */
async function closeApp(a: ElectronApplication | undefined): Promise<void> {
  if (!a) return;
  const pid = a.process().pid;
  const closed = await Promise.race([
    a.close().then(() => true, () => true),
    new Promise<boolean>((r) => setTimeout(() => r(false), 15_000)),
  ]);
  if (!closed && pid) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

test.beforeEach(async ({}, testInfo) => {
  testInfo.skip(!(await testPortIsFree()), `Port ${TEST_PORT} is in use on this machine — these tests need it free`);
  // The DEFAULT (scripts/windows present): scaffold/scripts/windows/*.ps1
  // are ordinary files tracked in the repo (confirmed via `git ls-tree`),
  // so a real `git clone` on macOS has them too, same as on Windows — they
  // are not Windows-only by virtue of being absent from a mac checkout.
  // getSetupState/startGranted must gate trayAvailable/shortcutsAvailable/
  // appWindowAvailable/background on process.platform === "win32"
  // themselves; this fixture deliberately does NOT rig that away by
  // omitting the files, so a regression in that platform gate shows up here
  // instead of only in a test built to avoid it.
  install = makeFakeInstall();
});

test.afterEach(async () => {
  // Before closing the app: the background server is launchd's child, so the
  // installer going away doesn't stop it, and its LaunchAgent must not be
  // left registered on this machine.
  if (install) stopTestLaunchAgent(install);
  await closeApp(app);
  app = undefined;
  killStandIns();
  install?.cleanup();
});

async function launch(extraEnv: Record<string, string> = {}): Promise<ElectronApplication> {
  const launched = await launchInstaller(install, extraEnv);
  app = launched.app;
  page = launched.page;
  return launched.app;
}

async function start(extraEnv: Record<string, string> = {}): Promise<ElectronApplication> {
  const a = await launch(extraEnv);
  await reachInstallComplete(a, page);
  return a;
}

function configureHostedKeys(): void {
  writeFileSync(join(install.scaffoldDir, ".env.local"), "OPENAI_API_KEY=sk-already-key-0000000000\nANTHROPIC_API_KEY=sk-ant-already-0000000000\n");
}

test("a finished install shows Installation complete and asks to open Granted, with no shortcut checkboxes (shortcuts stay Windows-only, and own-window needs scripts/macos, even though the real .ps1 files are present on this clone)", async () => {
  await start();
  await expect(page.getByText(`Granted is installed in ${install.installDir}.`)).toBeVisible();
  await expect(page.getByText("Open Granted now?")).toBeVisible();
  await expect(page.getByLabel("The desktop")).toHaveCount(0);
  // No scripts/macos in this install (see beforeEach), so no own-window box
  // either — and crucially not because of scripts/windows/open-granted.ps1,
  // which IS present here and must never count on macOS.
  await expect(page.getByLabel("Open Granted", { exact: true })).toHaveCount(0);
});

test("REGRESSION: a real clone's scripts/windows/*.ps1 files (present on every platform, not just Windows) must not route startGranted into the win32 tray path", async () => {
  // If startGranted's `background` check ever regresses back to a bare
  // existsSync(trayScriptPath()) with no platform guard, this would try to
  // launch granted-tray.ps1 through powershell.exe — nonexistent on macOS,
  // throwing, caught by the outer catch, always returning {ok:false,
  // message:"Couldn't start Granted."} — the mac launchMacScaffoldTask path
  // below would never run at all. Asserting the successful outcome here
  // (not just the absence of checkboxes) directly locks in that it doesn't.
  configureHostedKeys();
  const a = await start();
  await page.getByRole("button", { name: "Yes, open Granted" }).click();
  await expect(page.getByText(/Starting Granted/)).toBeVisible();
  await expect(page.getByRole("heading", { name: "Installation complete" })).toBeVisible();
  await expect(page.getByText(/Couldn't start Granted/)).toHaveCount(0);
  await expect(page.getByText(/Granted is open in your browser/)).toBeVisible({ timeout: 30_000 });
  expect(await openedUrls(a)).toEqual([TEST_URL]);
});

test("API keys already set: Yes starts Granted via the detached launchMacScaffoldTask path and opens a browser tab", async () => {
  configureHostedKeys();
  const a = await start();
  await page.getByRole("button", { name: "Yes, open Granted" }).click();
  await expect(page.getByText(/Starting Granted/)).toBeVisible();
  await expect(page.getByText(/Granted is open in your browser/)).toBeVisible({ timeout: 30_000 });
  // No scripts/macos in this install, so there is no LaunchAgent and no
  // menu-bar icon to mention — and, equally, no PowerShell window: this copy
  // used to be Windows's regardless of platform (the known gap this test
  // recorded), and is now worded for a mac install too old to have the
  // background runner.
  await expect(page.getByText(/keeps running in the background until you quit it or restart your Mac/)).toBeVisible();
  await expect(page.getByText(/PowerShell/)).toHaveCount(0);
  expect(await openedUrls(a)).toEqual([TEST_URL]);
});

test("run everything on this computer: runs setup:local --yes via launchMacScaffoldTask, then starts Granted and opens the browser", async () => {
  const a = await start();
  await page.getByRole("button", { name: "Yes, open Granted" }).click();
  await page.getByRole("button", { name: /Run everything on this computer/ }).click();
  await expect(page.getByText(/Setting up the local AI model/)).toBeVisible();
  await expect(page.getByText(/Granted is open in your browser/)).toBeVisible({ timeout: 60_000 });
  expect(readFileSync(join(install.scaffoldDir, ".env.local"), "utf8")).toMatch(/^LLM_PROVIDER=ollama$/m);
  expect(await openedUrls(a)).toEqual([TEST_URL]);
});

test("a failed local setup is reported with Try again, and doesn't start Granted", async () => {
  await start({ FAKE_SETUP_LOCAL_FAIL: "1" });
  await page.getByRole("button", { name: "Yes, open Granted" }).click();
  await page.getByRole("button", { name: /Run everything on this computer/ }).click();
  await expect(page.getByRole("button", { name: "Try again" })).toBeVisible({ timeout: 15_000 });
  expect(await openedUrls(app!)).toEqual([]);
});

test("an install with scripts/macos runs Granted in the background under its LaunchAgent, and the screen points at the menu-bar icon", async () => {
  // The real scripts/macos/granted-tray.sh, against a throwaway LaunchAgent
  // label with no menu-bar icon (see fixtures.ts) — so this exercises the
  // real background path the installer now takes on macOS, end to end,
  // without touching the real com.granted.server or anyone's menu bar.
  install.cleanup();
  install = makeFakeInstall({ withMacScripts: true });
  configureHostedKeys();
  const a = await start();
  await page.getByRole("button", { name: "Yes, open Granted" }).click();
  await expect(page.getByText(/Starting Granted in the background/)).toBeVisible();
  // This install has scripts/macos/open-granted.sh too, so Granted opens in
  // its own window (the stand-in app-mode browser) — the default preference.
  await expect(page.getByText(/Granted is open in its own window/)).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText(/look for the/)).toBeVisible();
  await expect(page.getByText(/icon.*in the menu bar at the top of your screen/)).toBeVisible();
  await expect(page.getByText(/by the clock/)).toHaveCount(0);
  await expect.poll(() => appWindowUrls(install), { timeout: 10_000 }).toEqual([TEST_URL]);
  expect(await openedUrls(a)).toEqual([]);
  // launchd really is running it: the agent is loaded and the server's
  // output is in the install's log folder, not a terminal.
  const loaded = execFileSync("launchctl", ["print", `gui/${process.getuid?.() ?? 0}/${install.launchLabel}`], { encoding: "utf8" });
  expect(loaded).toMatch(/state = running/);
  expect(readFileSync(join(install.logDir, `server-${TEST_PORT}.log`), "utf8")).toMatch(/fake Granted listening/);
});

test("an install with scripts/macos opens Granted in its own window by default: the box is ticked, and Yes opens an app window, not a browser tab", async () => {
  install.cleanup();
  install = makeFakeInstall({ withMacScripts: true });
  configureHostedKeys();
  const a = await start();
  await expect(page.getByLabel("Open Granted", { exact: true })).toBeChecked();
  await page.getByRole("button", { name: "Yes, open Granted" }).click();
  await expect(page.getByText(/Granted is open in its own window/)).toBeVisible({ timeout: 60_000 });
  // The stand-in app-mode browser logs from its own process, a moment after
  // the installer started it.
  await expect.poll(() => appWindowUrls(install), { timeout: 10_000 }).toEqual([TEST_URL]);
  expect(await openedUrls(a)).toEqual([]);
  // Left at the default: nothing needed saving.
  expect(existsSync(install.settingsPath)).toBe(false);
});

test("unticking 'its own window' opens a browser tab instead, and saves that for the menu-bar icon", async () => {
  install.cleanup();
  install = makeFakeInstall({ withMacScripts: true });
  configureHostedKeys();
  const a = await start();
  await page.getByLabel("Open Granted", { exact: true }).uncheck();
  await page.getByRole("button", { name: "Yes, open Granted" }).click();
  await expect(page.getByText(/Granted is open in your browser/)).toBeVisible({ timeout: 60_000 });
  expect(await openedUrls(a)).toEqual([TEST_URL]);
  expect(appWindowUrls(install)).toEqual([]);
  // The very same file, and the same key, the menu-bar helper reads.
  expect(JSON.parse(readFileSync(install.settingsPath, "utf8"))).toEqual({ openIn: "browser" });
});

test("a browser-tab preference saved earlier (from the menu-bar icon, say) starts the box unticked", async () => {
  install.cleanup();
  install = makeFakeInstall({ withMacScripts: true });
  mkdirSync(dirname(install.settingsPath), { recursive: true });
  writeFileSync(install.settingsPath, JSON.stringify({ openIn: "browser" }));
  await start();
  await expect(page.getByLabel("Open Granted", { exact: true })).not.toBeChecked();
});

test("with no Chrome or Edge on the Mac, Granted still opens, in a browser tab, and says so", async () => {
  install.cleanup();
  install = makeFakeInstall({ withMacScripts: true });
  configureHostedKeys();
  const a = await start({ GRANTED_APP_BROWSER: "none" });
  await page.getByRole("button", { name: "Yes, open Granted" }).click();
  await expect(page.getByText(/Granted is open in your browser/)).toBeVisible({ timeout: 60_000 });
  expect(await openedUrls(a)).toEqual([TEST_URL]);
  expect(appWindowUrls(install)).toEqual([]);
});

/** The Dock tiles in this fake install's throwaway `defaults` domain (never com.apple.dock). */
function dockEntries(): string {
  try {
    return execFileSync("defaults", ["export", install.dockDomain, "-"], { encoding: "utf8" });
  } catch {
    return ""; // nothing has ever been written to this domain
  }
}

test("an install with scripts/macos offers 'Add Granted to the Dock', ticked, and creates both the ~/Applications launcher and the Dock entry", async () => {
  install.cleanup();
  install = makeFakeInstall({ withMacScripts: true });
  await start();
  await expect(page.getByLabel("Add Granted to the Dock")).toBeChecked();
  // "Not now": this test is about the launcher and the Dock, so there is no
  // need to start a server and wait for it — the launcher actually starting
  // Granted is macLauncher.integration.test.ts's job.
  await page.getByRole("button", { name: "Not now" }).click();
  await expect(page.getByText("Added Granted to your Applications folder and to the Dock.")).toBeVisible();
  const appPath = join(install.applicationsDir, "Granted.app");
  expect(existsSync(join(appPath, "Contents", "Info.plist"))).toBe(true);
  expect(existsSync(join(appPath, "Contents", "MacOS", "Granted"))).toBe(true);
  expect(existsSync(join(appPath, "Contents", "Resources", "granted.icns"))).toBe(true);
  // The launcher runs this install's own tray script, with the test port.
  const launcher = readFileSync(join(appPath, "Contents", "MacOS", "Granted"), "utf8");
  // realpathSync: the script resolves its own folder with `pwd -P`, so the
  // path it bakes in is /private/var/folders/… where mkdtemp handed back
  // /var/folders/… (the same symlink the macTray integration test resolves).
  expect(launcher).toContain(join(realpathSync(install.scaffoldDir), "scripts", "macos", "granted-tray.sh"));
  expect(launcher).toContain(`--port ${TEST_PORT}`);
  expect(dockEntries()).toContain(appPath);
  // And the screen then tells the user where to open Granted from.
  await expect(page.getByText(/Open Granted any time from/)).toBeVisible();
  await expect(page.getByText(/from the Granted icon in the Dock/)).toBeVisible();
});

test("unticking 'Add Granted to the Dock' still creates the launcher, and leaves the Dock alone", async () => {
  install.cleanup();
  install = makeFakeInstall({ withMacScripts: true });
  await start();
  await page.getByLabel("Add Granted to the Dock").uncheck();
  await page.getByRole("button", { name: "Not now" }).click();
  // The launcher is not optional — only its place in the Dock is.
  await expect(page.getByText("Added Granted to your Applications folder.")).toBeVisible();
  expect(existsSync(join(install.applicationsDir, "Granted.app", "Contents", "MacOS", "Granted"))).toBe(true);
  expect(dockEntries()).not.toContain(join(install.applicationsDir, "Granted.app"));
  await expect(page.getByText(/from the Granted icon in the Dock/)).toHaveCount(0);
});

test("an install without scripts/macos offers no Dock box and creates no launcher", async () => {
  await start();
  await expect(page.getByLabel("Add Granted to the Dock")).toHaveCount(0);
  await page.getByRole("button", { name: "Not now" }).click();
  await expect(page.getByText(/Applications folder/)).toHaveCount(0);
  expect(existsSync(install.applicationsDir)).toBe(false);
  // The fallback text is Terminal's, not PowerShell's, on a Mac.
  await expect(page.getByText("To open Granted later, run these in Terminal:")).toBeVisible();
});

test("already running: Yes just opens the browser, without starting a second server", async () => {
  configureHostedKeys();
  const server = await serveOnTestPort(GRANTED_HTML);
  try {
    const a = await start();
    await page.getByRole("button", { name: "Yes, open Granted" }).click();
    await expect(page.getByText(/Granted was already running/)).toBeVisible();
    expect(await openedUrls(a)).toEqual([TEST_URL]);
  } finally {
    server.close();
  }
});
