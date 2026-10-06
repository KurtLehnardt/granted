/**
 * End-to-end: the built installer app on macOS, driven through its real UI,
 * reaching "Installation complete" (the install-status event win32 already
 * covers in openGranted.spec.ts, now also real on darwin) and then running
 * a FAKE Granted install's `npm run dev` / `npm run setup:local` for real
 * through the new launchMacScaffoldTask path — no console window, no tray,
 * no own app window (all separate, later work; this only exercises the
 * minimal background-process-plus-browser-tab path). The Terminal-launch
 * call itself (openInstallTerminal's darwin branch) is never exercised here,
 * same as openGranted.spec.ts never exercises win32's real PowerShell
 * launch: reachInstallComplete delivers the install's "done" event directly,
 * so no real Terminal window opens during this run either. macOS only.
 */
import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  GRANTED_HTML,
  TEST_PORT,
  TEST_URL,
  launchInstaller,
  makeFakeInstall,
  openedUrls,
  reachInstallComplete,
  serveOnTestPort,
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
  // No scripts/windows: a real macOS install has none of these, so
  // getSetupState's trayAvailable/shortcutsAvailable/appWindowAvailable
  // must all read false, the same as a real one.
  install = makeFakeInstall({ withWindowsScripts: false });
});

test.afterEach(async () => {
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

test("a finished install shows Installation complete and asks to open Granted, with no shortcut checkboxes (no scripts/windows on macOS)", async () => {
  await start();
  await expect(page.getByText(`Granted is installed in ${install.installDir}.`)).toBeVisible();
  await expect(page.getByText("Open Granted now?")).toBeVisible();
  await expect(page.getByLabel("The desktop")).toHaveCount(0);
  await expect(page.getByLabel("Open Granted", { exact: true })).toHaveCount(0);
});

test("API keys already set: Yes starts Granted via the background launchMacScaffoldTask path and opens a browser tab", async () => {
  configureHostedKeys();
  const a = await start();
  await page.getByRole("button", { name: "Yes, open Granted" }).click();
  await expect(page.getByText(/Starting Granted/)).toBeVisible();
  await expect(page.getByText(/Granted is open in your browser/)).toBeVisible({ timeout: 30_000 });
  // KNOWN GAP, not this task's job to fix (see the final report): the
  // non-background "opened" copy in InstallComplete.tsx is a hardcoded
  // string that says "Keep the Granted PowerShell window open" with no
  // platform check — on macOS there is no such window (launchMacScaffoldTask
  // has none), so this text is simply wrong here. Asserted present, not
  // absent, so this test documents today's real (flawed) behavior rather
  // than silently diverging from it.
  await expect(page.getByText(/Keep the Granted PowerShell window open/)).toBeVisible();
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
