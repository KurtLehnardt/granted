/**
 * End-to-end: the built installer app, driven through its real UI, opening
 * real console windows that run a fake Granted install's `npm run dev` /
 * `npm run setup:local`. Windows only — the "Installation complete" screen
 * follows on from Windows's install-status reporting, the only platform
 * that has it.
 */
import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  GRANTED_HTML,
  TEST_PORT,
  TEST_URL,
  killWindowsOpenedSince,
  launchInstaller,
  makeFakeInstall,
  openGrantedWindowPids,
  openedUrls,
  reachInstallComplete,
  readShortcut,
  sendInstallStatus,
  serveOnTestPort,
  stopTestTray,
  testPortIsFree,
  testTrayRunning,
  type FakeInstall,
} from "./fixtures";

test.skip(process.platform !== "win32", "The Installation complete screen is Windows-only");

let install: FakeInstall;
let app: ElectronApplication | undefined;
let page: Page;
let windowsBefore: number[] = [];

test.beforeEach(async ({}, testInfo) => {
  windowsBefore = openGrantedWindowPids();
  testInfo.skip(!(await testPortIsFree()), `Port ${TEST_PORT} is in use on this machine — these tests need it free`);
  install = makeFakeInstall();
});

test.afterEach(async () => {
  // The tray and console windows BEFORE the app: anything started via
  // `cmd /c start` inherits the app's stdio pipe handles (Playwright's,
  // here), so while one is still running app.close() hangs.
  if (install) stopTestTray(install);
  killWindowsOpenedSince(windowsBefore);
  await app?.close().catch(() => {});
  app = undefined;
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

function newWindows(): number[] {
  return openGrantedWindowPids().filter((p) => !windowsBefore.includes(p));
}

function configureHostedKeys(): void {
  writeFileSync(join(install.scaffoldDir, ".env.local"), "OPENAI_API_KEY=sk-already\nANTHROPIC_API_KEY=sk-ant-already\n");
}

test("a finished install shows Installation complete and asks to open Granted", async () => {
  await start();
  await expect(page.getByText(`Granted is installed in ${install.installDir}.`)).toBeVisible();
  await expect(page.getByText("Open Granted now?")).toBeVisible();
  await expect(page.getByRole("button", { name: "Yes, open Granted" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Not now" })).toBeVisible();
});

test("a failed install stays on the check screen, never Installation complete", async () => {
  // Deliberately NOT clicking "Open a terminal for me" — that would run the
  // real published install script. The event is what the main process
  // sends when install-windows.ps1 reports an error.
  const a = await launch();
  await page.getByRole("button", { name: "Get Started" }).click();
  await page.getByRole("heading", { name: "Checking your computer" }).waitFor();
  await sendInstallStatus(a, { state: "error", message: "git clone failed." });
  await page.waitForTimeout(500);
  await expect(page.getByRole("heading", { name: "Checking your computer" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Installation complete" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Open a terminal for me" })).toBeEnabled();
});

test("Not now still adds the ticked shortcuts, says where they are, and Close installer closes the app", async () => {
  const a = await start();
  await page.getByRole("button", { name: "Not now" }).click();
  await expect(page.getByText(/Open Granted any time from the Granted shortcut on your desktop or in the Start menu/)).toBeVisible();
  await expect(page.locator("code.command")).toContainText(`cd "${install.installDir}\\scaffold"`);
  expect(existsSync(join(install.desktopDir, "Granted.lnk"))).toBe(true);
  expect(existsSync(join(install.startMenuDir, "Granted.lnk"))).toBe(true);
  const closed = a.waitForEvent("close");
  await page.getByRole("button", { name: "Close installer" }).click();
  await closed;
  app = undefined;
});

test("API keys: rejects a missing key without writing anything, then saves, starts Granted and opens the browser", async () => {
  const a = await start();
  await page.getByRole("button", { name: "Yes, open Granted" }).click();
  await page.getByRole("button", { name: /Use my API keys/ }).click();

  const envLocal = join(install.scaffoldDir, ".env.local");
  await page.getByRole("button", { name: "Save and open Granted" }).click();
  await expect(page.getByText("Granted needs your OpenAI and Anthropic API keys to run.")).toBeVisible();
  await page.getByLabel(/OpenAI API key/).fill("sk-e2e-openai");
  await page.getByRole("button", { name: "Save and open Granted" }).click();
  await expect(page.getByText("Granted needs your Anthropic API key to run.")).toBeVisible();
  expect(existsSync(envLocal)).toBe(false);

  await page.getByLabel(/Anthropic API key/).fill("sk-ant-e2e-anthropic");
  await page.getByRole("button", { name: "Save and open Granted" }).click();
  await expect(page.getByText(/Starting Granted in the background/)).toBeVisible();
  await expect(page.getByText(/Granted is open in your browser/)).toBeVisible();
  await expect(page.getByText(TEST_URL, { exact: true })).toBeVisible();
  await expect(page.getByText(/keeps running in the background/)).toBeVisible();

  const env = readFileSync(envLocal, "utf8");
  expect(env).toMatch(/^OPENAI_API_KEY=sk-e2e-openai$/m);
  expect(env).toMatch(/^ANTHROPIC_API_KEY=sk-ant-e2e-anthropic$/m);
  expect(await openedUrls(a)).toEqual([TEST_URL]);
  // In the background: a tray, and no console window to keep open.
  expect(testTrayRunning()).toBe(true);
  expect(newWindows()).toHaveLength(0);
  const res = await fetch(`http://127.0.0.1:${TEST_PORT}/`);
  expect(await res.text()).toContain("federal funding intelligence");

  // The tray's own Quit stops it — and Granted with it.
  stopTestTray(install);
  await expect.poll(() => testPortIsFree(), { timeout: 15_000 }).toBe(true);
});

test("the shortcut boxes are ticked by default and create both shortcuts, launching Granted hidden in the background", async () => {
  configureHostedKeys(); // before launch: the screen reads the setup state when it opens
  await start();
  await expect(page.getByLabel("The desktop")).toBeChecked();
  await expect(page.getByLabel("The Start menu")).toBeChecked();
  await page.getByRole("button", { name: "Yes, open Granted" }).click();
  await expect(page.getByText("Added a Granted shortcut to your desktop and the Start menu.")).toBeVisible();
  await expect(page.getByText(/open it from the Granted shortcut on your desktop or in the Start menu/)).toBeVisible();

  for (const dir of [install.desktopDir, install.startMenuDir]) {
    const lnk = readShortcut(join(dir, "Granted.lnk"));
    expect(lnk.target).toMatch(/\\System32\\conhost\.exe$/i);
    expect(lnk.args).toMatch(/^--headless ".*powershell\.exe" .*-File ".*\\scripts\\windows\\granted-tray\.ps1" -OpenBrowser -Port 3987$/);
    expect(lnk.icon).toMatch(/granted\.ico,0$/);
  }
});

test("unticking a box skips that shortcut; unticking both creates none", async () => {
  await start();
  await page.getByLabel("The desktop").uncheck();
  await page.getByRole("button", { name: "Not now" }).click();
  await expect(page.getByText("Added a Granted shortcut to the Start menu.")).toBeVisible();
  expect(existsSync(join(install.desktopDir, "Granted.lnk"))).toBe(false);
  expect(existsSync(join(install.startMenuDir, "Granted.lnk"))).toBe(true);
});

test("no boxes ticked: no shortcuts and no shortcut message", async () => {
  await start();
  await page.getByLabel("The desktop").uncheck();
  await page.getByLabel("The Start menu").uncheck();
  await page.getByRole("button", { name: "Not now" }).click();
  await expect(page.getByText("To open Granted later, run these in PowerShell:")).toBeVisible();
  await expect(page.getByText(/Added a Granted shortcut/)).toHaveCount(0);
  expect(existsSync(install.desktopDir)).toBe(false);
  expect(existsSync(install.startMenuDir)).toBe(false);
});

test("an older install without the tray scripts falls back to the console window, and offers no shortcuts", async () => {
  install.cleanup();
  install = makeFakeInstall({ withWindowsScripts: false });
  configureHostedKeys(); // before launch: the screen reads the setup state when it opens
  const a = await start();
  await expect(page.getByLabel("The desktop")).toHaveCount(0);
  await page.getByRole("button", { name: "Yes, open Granted" }).click();
  await expect(page.getByText(/Granted is open in your browser/)).toBeVisible();
  await expect(page.getByText(/Keep the Granted PowerShell window open/)).toBeVisible();
  expect(newWindows()).toHaveLength(1);
  expect(testTrayRunning()).toBe(false);
  expect(await openedUrls(a)).toEqual([TEST_URL]);
});

test("already configured and already running: Yes just opens the browser, without a second server", async () => {
  configureHostedKeys();
  const server = await serveOnTestPort(GRANTED_HTML);
  try {
    const a = await start();
    await page.getByRole("button", { name: "Yes, open Granted" }).click();
    await expect(page.getByText(/Granted was already running/)).toBeVisible();
    expect(await openedUrls(a)).toEqual([TEST_URL]);
    expect(newWindows()).toHaveLength(0);
  } finally {
    server.close();
  }
});

test("another app on Granted's port is reported, never opened as if it were Granted", async () => {
  configureHostedKeys();
  const server = await serveOnTestPort("<title>Some other dev server</title>");
  try {
    const a = await start();
    await page.getByRole("button", { name: "Yes, open Granted" }).click();
    await expect(
      page.getByText(`Something is already using port ${TEST_PORT} and isn't showing Granted's home page`, { exact: false }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
    expect(await openedUrls(a)).toEqual([]);
    expect(newWindows()).toHaveLength(0);
  } finally {
    server.close();
  }
});

test("run everything on this computer: runs setup:local --yes, then starts Granted and opens the browser", async () => {
  const a = await start();
  await page.getByRole("button", { name: "Yes, open Granted" }).click();
  await page.getByRole("button", { name: /Run everything on this computer/ }).click();
  await expect(page.getByText(/Setting up the local AI model/)).toBeVisible();
  await expect(page.getByText(/Granted is open in your browser/)).toBeVisible({ timeout: 60_000 });
  expect(readFileSync(join(install.scaffoldDir, ".env.local"), "utf8")).toMatch(/^LLM_PROVIDER=ollama$/m);
  expect(await openedUrls(a)).toEqual([TEST_URL]);
});

test("closing the local setup window mid-way is reported right away, and Try again works", async () => {
  await start({ FAKE_SETUP_LOCAL_HANG: "1" });
  await page.getByRole("button", { name: "Yes, open Granted" }).click();
  await page.getByRole("button", { name: /Run everything on this computer/ }).click();
  await expect(page.getByText(/To cancel, close that window/)).toBeVisible();

  // Wait for its window, then close it the way a user would (PowerShell dies mid-command).
  await expect.poll(() => newWindows().length, { timeout: 30_000 }).toBe(1);
  killWindowsOpenedSince(windowsBefore);
  await expect(page.getByText("The local setup window was closed before it finished.")).toBeVisible({ timeout: 15_000 });

  // The wizard isn't stuck: Try again starts a fresh window.
  await page.getByRole("button", { name: "Try again" }).click();
  await expect.poll(() => newWindows().length, { timeout: 30_000 }).toBe(1);
});

test("an install folder that doesn't exist says so instead of offering to open Granted", async () => {
  ({ app, page } = await launchInstaller(`${install.installDir}-missing`));
  await reachInstallComplete(app, page);
  await expect(page.getByText(/Couldn't find Granted in/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Yes, open Granted" })).toHaveCount(0);
});

test("API keys form: a key that's already set is marked, and leaving it blank keeps it", async () => {
  writeFileSync(join(install.scaffoldDir, ".env.local"), "OPENAI_API_KEY=sk-existing\nANTHROPIC_API_KEY=sk-ant-...\n");
  const a = await start();
  await page.getByRole("button", { name: "Yes, open Granted" }).click();
  await page.getByRole("button", { name: /Use my API keys/ }).click();
  await expect(page.getByLabel(/OpenAI API key/)).toHaveAttribute("placeholder", /Already set/);
  await expect(page.getByLabel(/Anthropic API key/)).not.toHaveAttribute("placeholder", /Already set/);
  await page.getByLabel(/Anthropic API key/).fill("sk-ant-new");
  await page.getByRole("button", { name: "Save and open Granted" }).click();
  await expect(page.getByText(/Granted is open in your browser/)).toBeVisible();
  const env = readFileSync(join(install.scaffoldDir, ".env.local"), "utf8");
  expect(env).toMatch(/^OPENAI_API_KEY=sk-existing$/m);
  expect(env).toMatch(/^ANTHROPIC_API_KEY=sk-ant-new$/m);
  expect(await openedUrls(a)).toEqual([TEST_URL]);
});

test("a failed local setup shows the error with Try again, and doesn't start Granted", async () => {
  const a = await start({ FAKE_SETUP_LOCAL_FAIL: "1" });
  await page.getByRole("button", { name: "Yes, open Granted" }).click();
  await page.getByRole("button", { name: /Run everything on this computer/ }).click();
  await expect(page.getByText(/The local setup didn't finish/)).toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
  expect(await openedUrls(a)).toEqual([]);
  expect(await testPortIsFree()).toBe(true);
});
