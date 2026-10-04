/**
 * Shared setup for the end-to-end tests: a fake Granted install whose
 * `npm run dev` / `npm run setup:local` are tiny stand-ins (so a test takes
 * seconds, not a real Next.js compile or a multi-GB model pull), the real
 * built installer app launched via Playwright's Electron support, and
 * cleanup of the console windows the app opens.
 */
import { _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export const INSTALLER_ROOT = resolve(__dirname, "..");
// Not 3000: the installer is pointed here with GRANTED_PORT, so these tests
// never collide with (or mistake themselves for) a real Granted the
// developer has running on the default port.
export const TEST_PORT = 3987;
export const TEST_URL = `http://localhost:${TEST_PORT}`;
export const GRANTED_HTML = "<html><head><title>Granted — federal funding intelligence for everyone</title></head></html>";

export const ENV_EXAMPLE = [
  "OPENAI_API_KEY=sk-...",
  "ANTHROPIC_API_KEY=sk-ant-...",
  "EXA_API_KEY=",
  "NEXT_PUBLIC_FLAG_R5_DEEP_ANALYSIS=true",
  "",
].join("\n");

// Stand-in for `next dev -H 127.0.0.1`, which serves on $PORT (the
// installer sets it) — so this also proves the port is passed through.
const FAKE_DEV_SERVER = `
const port = Number(process.env.PORT);
if (!port) { console.error("fake dev server: PORT not set"); process.exit(1); }
require("node:http")
  .createServer((_req, res) => { res.writeHead(200, { "Content-Type": "text/html" }); res.end(${JSON.stringify(GRANTED_HTML)}); })
  .listen(port, "127.0.0.1", () => console.log("fake Granted listening on 127.0.0.1:" + port));
`;

// Stand-in for scripts/setup-local.mjs: writes what the real one writes on
// success, or fails when the test asks it to.
const FAKE_SETUP_LOCAL = `
const fs = require("node:fs");
if (process.env.FAKE_SETUP_LOCAL_FAIL === "1") { console.error("fake setup:local failing on purpose"); process.exit(1); }
const existing = fs.existsSync(".env.local") ? fs.readFileSync(".env.local", "utf8") : fs.readFileSync(".env.example", "utf8");
fs.writeFileSync(".env.local", existing + "LLM_PROVIDER=ollama\\nEMBEDDINGS_BASE_URL=http://localhost:11434/v1\\n");
console.log("fake setup:local done; args:", process.argv.slice(2).join(" "));
`;

export interface FakeInstall {
  root: string;
  installDir: string;
  scaffoldDir: string;
  cleanup: () => void;
}

export function makeFakeInstall(): FakeInstall {
  const root = mkdtempSync(join(tmpdir(), "granted-e2e-"));
  const installDir = join(root, "granted");
  const scaffoldDir = join(installDir, "scaffold");
  mkdirSync(scaffoldDir, { recursive: true });
  writeFileSync(
    join(scaffoldDir, "package.json"),
    JSON.stringify(
      { name: "fake-granted", private: true, scripts: { dev: "node fake-dev.js", "setup:local": "node fake-setup-local.js" } },
      null,
      2,
    ),
  );
  writeFileSync(join(scaffoldDir, ".env.example"), ENV_EXAMPLE);
  writeFileSync(join(scaffoldDir, "fake-dev.js"), FAKE_DEV_SERVER);
  writeFileSync(join(scaffoldDir, "fake-setup-local.js"), FAKE_SETUP_LOCAL);
  return { root, installDir, scaffoldDir, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

export async function launchInstaller(
  installDir: string,
  extraEnv: Record<string, string> = {},
): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({
    args: [INSTALLER_ROOT],
    env: {
      ...process.env,
      GRANTED_INSTALL_DIR: installDir,
      GRANTED_PORT: String(TEST_PORT),
      ...extraEnv,
    } as Record<string, string>,
  });
  // Never open a real browser from a test: record what would have been opened.
  await app.evaluate(({ shell }) => {
    const opened: string[] = [];
    (globalThis as unknown as { __opened: string[] }).__opened = opened;
    shell.openExternal = async (url: string): Promise<void> => {
      opened.push(url);
    };
  });
  const page = await app.firstWindow();
  return { app, page };
}

export async function openedUrls(app: ElectronApplication): Promise<string[]> {
  return app.evaluate(() => (globalThis as unknown as { __opened: string[] }).__opened);
}

/**
 * Welcome → PrereqCheck, then deliver the same "install finished" event the
 * main process sends when install-windows.ps1 reports done — the real
 * install itself (winget, git clone, npm ci) is exercised by the manual
 * full-machine test, not here.
 */
export async function reachInstallComplete(app: ElectronApplication, page: Page): Promise<void> {
  await page.getByRole("button", { name: "Get Started" }).click();
  await page.getByRole("heading", { name: "Checking your computer" }).waitFor();
  await sendInstallStatus(app, { state: "done", message: null });
  await page.getByRole("heading", { name: "Installation complete" }).waitFor();
}

export async function sendInstallStatus(
  app: ElectronApplication,
  status: { state: "running" | "done" | "error"; message: string | null },
): Promise<void> {
  await app.evaluate(({ BrowserWindow }, s) => {
    BrowserWindow.getAllWindows()[0].webContents.send("terminal:install-status", s);
  }, status);
}

/** Starts a server on the test port inside the test process (for "already running" / "port taken"). */
export function serveOnTestPort(body: string): Promise<Server> {
  return new Promise((resolveServer, reject) => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(body);
    });
    server.once("error", reject);
    server.listen(TEST_PORT, "127.0.0.1", () => resolveServer(server));
  });
}

export async function testPortIsFree(): Promise<boolean> {
  try {
    const server = await serveOnTestPort("");
    await new Promise<void>((r) => server.close(() => r()));
    return true;
  } catch {
    return false;
  }
}

/** Runs a PowerShell snippet (via -EncodedCommand, so no shell-quoting games) and returns stdout. */
function powershell(script: string): string {
  const encoded = Buffer.from(`$ProgressPreference = 'SilentlyContinue'\n${script}`, "utf16le").toString("base64");
  return execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], {
    encoding: "utf8",
    windowsHide: true,
    // stderr carries PowerShell's CLIXML progress records, not errors worth showing.
    stdio: ["ignore", "pipe", "ignore"],
  });
}

/** PIDs of the console windows the app opens for "Open Granted" (a granted-start-app-/granted-local-setup- script). */
export function openGrantedWindowPids(): number[] {
  const out = powershell(
    "Get-CimInstance Win32_Process -Filter \"Name='powershell.exe'\" | " +
      "Where-Object { $_.CommandLine -match 'granted-(start-app|local-setup)-[0-9a-f-]+\\.ps1' } | " +
      "ForEach-Object { $_.ProcessId }",
  );
  return out
    .split(/\r?\n/)
    .map((l) => Number(l.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
}

/**
 * Closes the console windows opened since `before` was snapshotted (and so
 * the fake dev server running in one). They're launched detached on purpose
 * — so Granted keeps running after the installer closes — which means
 * closing the app doesn't stop them. Only NEW windows are touched, so a real
 * Granted the developer has running is left alone.
 */
export function killWindowsOpenedSince(before: number[]): void {
  for (const pid of openGrantedWindowPids().filter((p) => !before.includes(p))) {
    try {
      execFileSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
    } catch {
      /* already gone */
    }
  }
}
