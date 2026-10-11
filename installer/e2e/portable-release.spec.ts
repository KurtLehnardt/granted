/**
 * Smoke test of the RELEASE ASSET ITSELF: the single `Granted-Setup-x.y.z.exe`
 * a user downloads from the GitHub release and double-clicks. Run it with
 *   GRANTED_PORTABLE_EXE=C:\path\to\Granted-Setup-1.0.4.exe
 *   GRANTED_EXPECT_TAG=v1.0.4
 * (.github/workflows/portable-release-e2e.yml does, against the real
 * published asset, after verifying its SHA-256 against SHA256SUMS.txt).
 *
 * Deliberately NOT the same thing as e2e/packaged.spec.ts. That one points
 * GRANTED_PACKAGED_EXE at `dist\win-unpacked\Granted Setup.exe` — the
 * already-unpacked folder electron-builder leaves behind in the build that
 * produced the release, which nobody downloads. This one starts from the
 * published file and goes through the layer in between, which has never
 * otherwise been tested: the `portable` wrapper.
 *
 * What that wrapper is, from app-builder-lib's own
 * templates/nsis/portable.nsi (the script electron-builder compiles for
 * `"target": "portable"`):
 *
 *   StrCpy $INSTDIR "$PLUGINSDIR\app"
 *   !ifdef UNPACK_DIR_NAME
 *     StrCpy $INSTDIR "$TEMP\${UNPACK_DIR_NAME}"
 *   !endif
 *   RMDir /r $INSTDIR
 *   SetOutPath $INSTDIR
 *   ... File /r "${APP_DIR_64}\*.*" ...
 *   System::Call '...SetEnvironmentVariable(... "PORTABLE_EXECUTABLE_DIR", "$EXEDIR")...'
 *   ${StdUtils.GetAllParameters} $R0 0
 *   ExecWait "$INSTDIR\${APP_EXECUTABLE_FILENAME} $R0" $0
 *   SetErrorLevel $0
 *   SetOutPath $EXEDIR
 *   RMDir /r $INSTDIR
 *
 * So the .exe is a silent self-extractor (`SetSilent silent`, no splash
 * image is configured) that:
 *
 *  - extracts the whole app to `%TEMP%\<UNPACK_DIR_NAME>`. That name is
 *    fixed at BUILD time, not install time: out/targets/nsis/NsisTarget.js
 *    does `defines.UNPACK_DIR_NAME = unpackDirName || generateKsuid()`, and
 *    installer/package.json sets no `portable.unpackDirName`, so every run
 *    of a given .exe extracts to the same randomly-named %TEMP% folder. It
 *    cannot be predicted from the outside, hence the scan below.
 *  - runs the extracted `Granted Setup.exe` as a child, FORWARDING its own
 *    command line to it (GetAllParameters), and stays alive as that child's
 *    parent for as long as it runs (ExecWait), passing its exit code on.
 *  - deletes the extraction folder once the app exits.
 *
 * Two consequences shape this test. First, `_electron.launch()` on the
 * wrapper cannot work — Playwright would be talking to an NSIS process,
 * never to the Electron one it spawns a layer down — which is exactly how
 * this gap was found (a run against the published 1.0.4 asset timed out
 * waiting for a window). Second, because the wrapper forwards its command
 * line, the app can be launched with `--remote-debugging-port` and attached
 * to over CDP, which is how this test drives the app it did not launch
 * itself.
 */
import { test, expect, chromium, type Browser, type Page } from "@playwright/test";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createServer as createSocketServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeFakeInstall, powershell, type FakeInstall } from "./fixtures";

const portable = process.env["GRANTED_PORTABLE_EXE"];
const expectTag = process.env["GRANTED_EXPECT_TAG"];

test.skip(!portable || !expectTag, "Set GRANTED_PORTABLE_EXE (a downloaded release .exe) and GRANTED_EXPECT_TAG to smoke-test it");

/** electron-builder's `productName`: the executable inside the wrapper's payload, not the wrapper itself. */
const APP_EXE = "Granted Setup.exe";

/**
 * Folders that hold an extracted copy of the app, found by looking for the
 * two files that only a complete-enough payload has. `%TEMP%\<name>` is
 * where a build with UNPACK_DIR_NAME (always, see the header) extracts;
 * `%TEMP%\<name>\app` is where one without it would ($PLUGINSDIR\app), kept
 * so this still finds the payload if that default ever changes.
 *
 * The wrapper inherits this process's environment (the test passes it),
 * so NSIS's $TEMP and Node's tmpdir() are the same folder.
 */
function extractedAppDirs(): string[] {
  const temp = tmpdir();
  let names: string[];
  try {
    names = readdirSync(temp);
  } catch {
    return [];
  }
  const found: string[] = [];
  for (const name of names) {
    for (const dir of [join(temp, name), join(temp, name, "app")]) {
      try {
        if (!statSync(dir).isDirectory()) continue;
        if (existsSync(join(dir, APP_EXE)) && existsSync(join(dir, "resources", "app.asar"))) found.push(dir);
      } catch {
        /* vanished mid-scan, or another user's temp folder */
      }
    }
  }
  return found;
}

interface AppProcess {
  pid: number;
  /** The wrapper, for the app the wrapper started. */
  parent: number;
  /** Where it is running FROM — the proof it is the extracted copy. */
  path: string;
}

/** Every running `Granted Setup.exe` (the wrapper has the release's own file name, so it is never one of these). */
function appProcesses(): AppProcess[] {
  const out = powershell(
    `Get-CimInstance Win32_Process -Filter "Name='${APP_EXE}'" | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId) $($_.ExecutablePath)" }`,
  );
  return out
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [pid, parent, ...path] = line.split(" ");
      return { pid: Number(pid), parent: Number(parent), path: path.join(" ") };
    })
    .filter((p) => Number.isInteger(p.pid) && p.pid > 0);
}

/** A port nothing is listening on, to hand the app as its CDP port. */
async function freePort(): Promise<number> {
  const probe = createSocketServer();
  await new Promise<void>((r) => probe.listen(0, "127.0.0.1", () => r()));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((r) => probe.close(() => r()));
  return port;
}

/**
 * Polls until `probe` returns something other than undefined/false, or the
 * deadline passes — the shape every wait here needs (an extracted folder, a
 * process, an endpoint), none of which Playwright's own waiting covers.
 */
async function waitFor<T>(what: string, timeoutMs: number, probe: () => T | undefined | false | Promise<T | undefined | false>): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  for (;;) {
    try {
      const value = await probe();
      if (value !== undefined && value !== false) return value;
    } catch (err) {
      lastError = err;
    }
    if (Date.now() >= deadline) {
      throw new Error(`Timed out after ${timeoutMs}ms waiting for ${what}${lastError ? `: ${String(lastError)}` : ""}`);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}

/** The last resort for cleanup: the whole process tree, no questions asked. */
function taskkill(pid: number): void {
  try {
    execFileSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
  } catch {
    /* already gone */
  }
}

let wrapper: ChildProcess | undefined;
let wrapperExited = false;
/** The exit code the wrapper passed on from the app it ran (SetErrorLevel $0). */
let wrapperCode: number | null = null;
let browser: Browser | undefined;
let releases: Server | undefined;
let install: FakeInstall | undefined;
/** Set once found, cleared once the wrapper has deleted it — so cleanup knows whether anything is left. */
let extractDir: string | undefined;

test.afterEach(() => {
  if (process.platform !== "win32") return;
  void browser?.close().catch(() => {});
  browser = undefined;
  // A failure anywhere above can leave the app (and so the wrapper, which
  // waits on it) running. Kill the tree, then anything still running out of
  // the extraction folder, then delete it: a release smoke test must not
  // leave a GUI app or 100 MB of %TEMP% behind for the next run to trip on.
  if (wrapper?.pid && !wrapperExited) taskkill(wrapper.pid);
  wrapper = undefined;
  wrapperExited = false;
  wrapperCode = null;
  for (const dir of extractDir ? [extractDir] : extractedAppDirs()) {
    for (const p of appProcesses()) {
      if (p.path.toLowerCase().startsWith(dir.toLowerCase())) taskkill(p.pid);
    }
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
  }
  extractDir = undefined;
  releases?.close();
  releases = undefined;
  install?.cleanup();
  install = undefined;
});

test("the published portable .exe extracts the app, runs it, and installs its own baked-in release", async () => {
  test.skip(process.platform !== "win32", "The portable .exe is the Windows release asset");
  // Extracting ~100 MB, starting Electron, and the real prerequisite check
  // on a cold runner all happen inside this one test.
  test.setTimeout(300_000);

  // Anything an earlier run of this same .exe left behind: its extraction
  // folder has a fixed name, so a leftover would otherwise be indistinguishable
  // from the one this run is waiting for. (The wrapper deletes it itself on a
  // clean exit; this covers a run that was killed.)
  for (const dir of extractedAppDirs()) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });

  install = makeFakeInstall();
  // A newer release than the baked-in one, so the version note has something
  // to report — the same stand-in GitHub API packaged.spec.ts uses.
  releases = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ tag_name: "v999.0.0" }));
  });
  await new Promise<void>((r) => releases!.listen(0, "127.0.0.1", () => r()));
  const cdpPort = await freePort();
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    GRANTED_INSTALL_DIR: install.installDir,
    GRANTED_RELEASES_API: `http://127.0.0.1:${(releases.address() as AddressInfo).port}/`,
  };
  delete env["GRANTED_RELEASE_TAG"]; // the tag baked into the downloaded .exe must be what's used

  // Plain spawn, not _electron.launch: this is an NSIS self-extractor, and
  // Playwright can only speak to the Electron process a layer below it.
  wrapper = spawn(portable!, [`--remote-debugging-port=${cdpPort}`], { env, stdio: "ignore", windowsHide: true });
  wrapper.on("exit", (code) => {
    wrapperExited = true;
    wrapperCode = code;
  });
  const wrapperPid = await waitFor("the portable .exe to start", 30_000, () => wrapper?.pid);
  console.log(`portable exe: ${portable} (pid ${wrapperPid}), CDP port ${cdpPort}`);

  // 1. It really does extract the app, to its own folder under %TEMP%.
  extractDir = await waitFor(`the portable .exe to extract ${APP_EXE} under ${tmpdir()}`, 180_000, () => extractedAppDirs()[0]);
  console.log(`extracted to: ${extractDir}`);

  // 2. It runs THAT copy, as its own child, and stays alive as its parent
  //    (ExecWait) — the behaviour that makes attaching, rather than
  //    launching, the only way to drive the app.
  const app = await waitFor("the extracted app to be running as the wrapper's child", 120_000, () =>
    appProcesses().find((p) => p.parent === wrapperPid),
  );
  console.log(`app running as pid ${app.pid}, child of ${app.parent}, from ${app.path}`);
  expect(app.path.toLowerCase().startsWith(extractDir.toLowerCase()), `${app.path} should be inside ${extractDir}`).toBe(true);
  expect(wrapperExited, "the wrapper waits on the app (ExecWait), so it must still be running").toBe(false);

  // 3. The app the wrapper started is a working installer. Attached to over
  //    CDP, which it is listening for only because the wrapper forwarded the
  //    command line it was given.
  const endpoint = `http://127.0.0.1:${cdpPort}`;
  await waitFor("the app's DevTools endpoint", 120_000, async () => {
    const res = await fetch(`${endpoint}/json/version`, { signal: AbortSignal.timeout(2_000) });
    return res.ok;
  });
  browser = await chromium.connectOverCDP(endpoint);
  const page: Page = await waitFor("the installer window", 60_000, () => browser?.contexts()[0]?.pages()[0]);
  await page.waitForLoadState("domcontentloaded");

  // The same flow (and the same GRANTED_EXPECT_TAG check) packaged.spec.ts
  // runs against the unpacked build, so what this adds is only the artifact
  // it reaches it through.
  await page.getByRole("button", { name: "Get Started" }).click();
  await page.getByRole("heading", { name: "Checking your computer" }).waitFor();
  const note = page.getByTestId("install-version");
  await expect(note).toHaveText("A newer version is available: Granted v999.0.0 will be installed.");
  await page.getByLabel("Check for and install the latest version of Granted").uncheck();
  // The release baked into the downloaded file, which is the whole point of
  // running this against a real published asset.
  await expect(note).toHaveText(`Granted ${expectTag} (this installer's version) will be installed.`);

  // 4. Closing the app leaves nothing behind: the wrapper's ExecWait returns
  //    and it deletes its extraction folder. Closed through the installer's
  //    own Close button (window.api.quit(), the `app:quit` IPC that closes
  //    the window, which quits the app) rather than killed, for two reasons:
  //    a killed app's children can still be holding files when NSIS tries to
  //    delete them, and an app shut down by the thing a user actually clicks
  //    is the shutdown worth testing. A WM_CLOSE from taskkill was the first
  //    attempt and is NOT equivalent: it needs a window on an interactive
  //    desktop, so it does nothing when this runs as a service (an EC2 SSM
  //    command, say), while the IPC works in any session.
  //
  //    The evaluate itself usually rejects — the window it is talking to is
  //    gone before the call can answer — which is the point of it. It goes
  //    through globalThis because this file is typechecked with the Node
  //    libs, which have no `window`.
  await page.evaluate(() => (globalThis as unknown as { api: { quit: () => void } }).api.quit()).catch(() => {});
  await browser.close().catch(() => {});
  browser = undefined;
  await waitFor("the app to exit", 90_000, () => !appProcesses().some((p) => p.pid === app.pid));
  await waitFor("the wrapper to exit once the app it waits on has", 90_000, () => wrapperExited);
  // The app's own exit code, passed on by the wrapper (SetErrorLevel $0) —
  // so a user's shortcut or script sees the installer's result, not the
  // extractor's.
  expect(wrapperCode, "the wrapper passes on the app's exit code").toBe(0);
  await waitFor("the wrapper to delete its extraction folder", 90_000, () => !existsSync(extractDir!));
  console.log(`closed cleanly; wrapper exited ${wrapperCode} and removed ${extractDir}`);
  extractDir = undefined;
});
