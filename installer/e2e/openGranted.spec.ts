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
  sendInstallStatus,
  serveOnTestPort,
  testPortIsFree,
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
  // Windows BEFORE the app: a console window started via `cmd /c start`
  // inherits the app's stdio pipe handles (Playwright's, here), so while one
  // is still open the app never reads as closed and app.close() hangs.
  killWindowsOpenedSince(windowsBefore);
  await app?.close().catch(() => {});
  app = undefined;
  install?.cleanup();
});

async function launch(extraEnv: Record<string, string> = {}): Promise<ElectronApplication> {
  const launched = await launchInstaller(install.installDir, extraEnv);
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

test("Not now shows how to open Granted later, and Close installer closes the app", async () => {
  const a = await start();
  await page.getByRole("button", { name: "Not now" }).click();
  await expect(page.locator("code.command")).toContainText(`cd "${install.installDir}\\scaffold"`);
  await expect(page.locator("code.command")).toContainText("npm run dev");
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
  await expect(page.getByText(/Granted is open in your browser/)).toBeVisible();
  await expect(page.getByText(TEST_URL, { exact: true })).toBeVisible();

  const env = readFileSync(envLocal, "utf8");
  expect(env).toMatch(/^OPENAI_API_KEY=sk-e2e-openai$/m);
  expect(env).toMatch(/^ANTHROPIC_API_KEY=sk-ant-e2e-anthropic$/m);
  expect(await openedUrls(a)).toEqual([TEST_URL]);
  expect(newWindows()).toHaveLength(1);
  const res = await fetch(`http://127.0.0.1:${TEST_PORT}/`);
  expect(await res.text()).toContain("federal funding intelligence");
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
    await expect(page.getByText(`Another program is already using port ${TEST_PORT}`, { exact: false })).toBeVisible();
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

test("a failed local setup shows the error with Try again, and doesn't start Granted", async () => {
  const a = await start({ FAKE_SETUP_LOCAL_FAIL: "1" });
  await page.getByRole("button", { name: "Yes, open Granted" }).click();
  await page.getByRole("button", { name: /Run everything on this computer/ }).click();
  await expect(page.getByText(/The local setup didn't finish/)).toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
  expect(await openedUrls(a)).toEqual([]);
  expect(await testPortIsFree()).toBe(true);
});
