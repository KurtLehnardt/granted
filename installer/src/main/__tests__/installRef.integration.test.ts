/**
 * Integration: the REAL install-windows.ps1 installing a specific release
 * (GRANTED_REF) — what the downloadable Granted-Setup-x.y.z.exe asks for —
 * from local stand-in repos (GRANTED_REPO_URL) with release tags, so it runs
 * offline and fast. Covers a fresh pinned install, updating an install this
 * script made, and everything an update must NOT do: switch a folder with
 * local changes or one it didn't make, go backwards, break on a re-tagged
 * release, or run npm ci under a still-running Granted. Git and Node must
 * already be installed (they are wherever this runs), so nothing is
 * downloaded. Registry, LOCALAPPDATA and the port are test-only. Windows only.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync, spawn, type ChildProcess } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { probeGranted, readStatusFile } from "../openGranted";

const execFileAsync = promisify(execFile);
const REPO_ROOT = resolve(process.cwd(), "..");
const INSTALL_SCRIPT = join(REPO_ROOT, "install-windows.ps1");
const WINDOWS_SCRIPTS = join(REPO_ROOT, "scaffold", "scripts", "windows");
const PORT = 3979;
const GRANTED_HTML = "<title>Granted — federal funding intelligence for everyone</title>";

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.com", "-c", "advice.detachedHead=false", ...args], {
    cwd,
    encoding: "utf8",
    windowsHide: true,
  }).trim();
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe("install-windows.ps1 with GRANTED_REF (a pinned release)", { skip: (process.platform !== "win32" || !existsSync(INSTALL_SCRIPT)) && "Windows only, run from installer/" }, () => {
  let root: string;
  const keyParent = `HKCU:\\Software\\GrantedTests\\${randomUUID()}`;
  const started: ChildProcess[] = [];
  let seq = 0;

  /** Commits scaffold at `version` (a runnable fake: `npm run dev` serves Granted's page on $PORT), optionally tagging it. */
  function commitVersion(source: string, version: string, tag: string | null, extraFile?: string): void {
    const scaffold = join(source, "scaffold");
    writeFileSync(join(scaffold, "package.json"), JSON.stringify({ name: "granted", version, private: true, scripts: { dev: "node server.js" } }, null, 2));
    writeFileSync(
      join(scaffold, "package-lock.json"),
      JSON.stringify({ name: "granted", version, lockfileVersion: 3, requires: true, packages: { "": { name: "granted", version } } }, null, 2),
    );
    writeFileSync(join(scaffold, "server.js"), `require("node:http").createServer((q, r) => r.end(${JSON.stringify(GRANTED_HTML)})).listen(Number(process.env.PORT), "127.0.0.1");`);
    if (extraFile) writeFileSync(join(scaffold, extraFile), extraFile);
    git(source, "add", "-A");
    git(source, "commit", "-q", "-m", `version ${version}`);
    if (tag) git(source, "tag", "-f", "-a", tag, "-m", tag); // annotated, as real releases are
  }

  /** A stand-in for the GitHub repo: v0.1.0, v0.2.0, then main moved on to 0.3.0-dev. */
  function makeSource(): string {
    const source = join(root, `source-${seq++}`);
    mkdirSync(join(source, "scaffold", "scripts", "windows"), { recursive: true });
    for (const f of readdirSync(WINDOWS_SCRIPTS)) copyFileSync(join(WINDOWS_SCRIPTS, f), join(source, "scaffold", "scripts", "windows", f));
    git(source, "init", "-q", "-b", "main");
    commitVersion(source, "0.1.0", "v0.1.0");
    commitVersion(source, "0.2.0", "v0.2.0");
    commitVersion(source, "0.3.0-dev", null);
    return source;
  }

  /** Runs the real script in `home`; returns its status and console output. */
  async function runInstall(home: string, source: string, ref: string | null, extra: Record<string, string> = {}): Promise<{ state: string | null; message: string | null; output: string }> {
    const status = join(root, `status-${seq++}.json`);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      GRANTED_REPO_URL: source,
      GRANTED_INSTALL_DIR: "granted",
      GRANTED_STATUS_FILE: status,
      GRANTED_UNINSTALL_KEY_ROOT: `${keyParent}\\Uninstall`,
      LOCALAPPDATA: join(root, "LocalAppData"),
      GRANTED_SETTINGS_PATH: join(root, "LocalAppData", "Granted", "settings.json"),
      // A re-run stops a running tray on GRANTED_PORT: never a real Granted's.
      GRANTED_PORT: String(PORT),
      npm_config_audit: "false",
      npm_config_fund: "false",
      ...extra,
    };
    if (ref) env["GRANTED_REF"] = ref;
    else delete env["GRANTED_REF"];
    let output = "";
    try {
      const r = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", INSTALL_SCRIPT], {
        cwd: home,
        env,
        windowsHide: true,
        timeout: 180_000,
      });
      output = r.stdout + r.stderr;
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string };
      output = (e.stdout ?? "") + (e.stderr ?? "");
    }
    const s = await readStatusFile(status);
    return { state: s?.state ?? null, message: s?.message ?? null, output };
  }

  const versionIn = (home: string): string => (JSON.parse(readFileSync(join(home, "granted", "scaffold", "package.json"), "utf8")) as { version: string }).version;
  const listedVersion = (): string =>
    execFileSync("powershell.exe", ["-NoProfile", "-Command", `(Get-ChildItem '${keyParent}\\Uninstall' | Get-ItemProperty | Sort-Object InstallDate | Select-Object -Last 1).DisplayVersion`], {
      encoding: "utf8",
    }).trim();
  const freshHome = (): string => {
    const d = join(root, `home-${seq++}`);
    mkdirSync(d, { recursive: true });
    return d;
  };

  before(async () => {
    root = await mkdtemp(join(tmpdir(), "granted-installref-it-"));
  });

  after(async () => {
    for (const c of started) if (c.exitCode === null) c.kill();
    await execFileAsync("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `Remove-Item -Path '${keyParent}' -Recurse -Force -ErrorAction SilentlyContinue; if (-not (Get-ChildItem 'HKCU:\\Software\\GrantedTests' -ErrorAction SilentlyContinue)) { Remove-Item 'HKCU:\\Software\\GrantedTests' -Force -ErrorAction SilentlyContinue }`,
    ]).catch(() => {});
    await rm(root, { recursive: true, force: true }).catch(() => {});
  });

  test("a fresh install of v0.1.0 gets exactly v0.1.0 (not v0.2.0 or main), marked as installer-made, listed at 0.1.0; v0.2.0 then updates it", async () => {
    const source = makeSource();
    const home = freshHome();
    const r = await runInstall(home, source, "v0.1.0");
    assert.equal(r.state, "done", r.output);
    assert.equal(versionIn(home), "0.1.0");
    assert.equal(git(join(home, "granted"), "describe", "--tags", "--exact-match"), "v0.1.0");
    assert.ok(existsSync(join(home, "granted", ".git", "granted-installer")), "marked as made by the installer");
    assert.doesNotMatch(r.output, /is not a commit/, "no scary git warning for the (annotated) release tag");
    assert.match(r.output, /carry on in the Granted installer/, "run by the installer app: no terminal next steps");
    assert.doesNotMatch(r.output, /npm run setup/);
    assert.equal(listedVersion(), "0.1.0");

    const update = await runInstall(home, source, "v0.2.0");
    assert.equal(update.state, "done", update.output);
    assert.equal(versionIn(home), "0.2.0");
    assert.match(update.output, /now at v0\.2\.0/);
    assert.equal(listedVersion(), "0.2.0", "Installed apps shows the new version");

    // Local changes: never switched over them.
    writeFileSync(join(home, "granted", "scaffold", "package.json"), readFileSync(join(home, "granted", "scaffold", "package.json"), "utf8") + "\n");
    git(source, "tag", "v0.2.1", "v0.2.0");
    const kept = await runInstall(home, source, "v0.2.1");
    assert.equal(kept.state, "done", kept.output);
    assert.match(kept.output, /has local changes/);
  });

  test("REGRESSION (review): never backwards — an install already containing the release, or with newer code, is left alone", async () => {
    const source = makeSource();
    // Installed from main (the README one-liner): 0.3.0-dev, already past v0.2.0.
    const fromMain = freshHome();
    assert.equal((await runInstall(fromMain, source, null)).state, "done");
    assert.equal(versionIn(fromMain), "0.3.0-dev");
    const r1 = await runInstall(fromMain, source, "v0.2.0");
    assert.equal(r1.state, "done", r1.output);
    assert.match(r1.output, /already includes Granted v0\.2\.0/);
    assert.equal(versionIn(fromMain), "0.3.0-dev", "not moved back to v0.2.0");

    // At v0.2.0, an old installer (v0.1.0) run again: v0.1.0 is already in its history.
    const at020 = freshHome();
    await runInstall(at020, source, "v0.2.0");
    assert.match((await runInstall(at020, source, "v0.1.0")).output, /already includes Granted v0\.1\.0/);
    assert.equal(versionIn(at020), "0.2.0");

    // An older release NOT in its history (a patch on an old line): refused by version...
    git(source, "checkout", "-q", "-b", "maint-0.1", "v0.1.0");
    commitVersion(source, "0.1.5", "v0.1.5", "patch.txt");
    git(source, "checkout", "-q", "main");
    const refused = await runInstall(at020, source, "v0.1.5");
    assert.equal(refused.state, "done", refused.output);
    assert.match(refused.output, /already has a newer Granted \(0\.2\.0\)/);
    assert.equal(versionIn(at020), "0.2.0");
    // ...unless explicitly allowed.
    const allowed = await runInstall(at020, source, "v0.1.5", { GRANTED_ALLOW_DOWNGRADE: "1" });
    assert.equal(allowed.state, "done", allowed.output);
    assert.equal(versionIn(at020), "0.1.5");
  });

  test("REGRESSION (review): a release re-tagged on GitHub (moved to a fix) neither breaks updates nor installs the stale copy", async () => {
    const source = makeSource();
    const home = freshHome();
    await runInstall(home, source, "v0.1.0"); // the clone now has v0.1.0 AND v0.2.0 locally
    // Both tags move: v0.1.0 (any tag the clone has) and v0.2.0 (the one asked for).
    git(source, "checkout", "-q", "-b", "fixes", "v0.1.0");
    commitVersion(source, "0.1.0", "v0.1.0", "fix-010.txt");
    git(source, "checkout", "-q", "main");
    git(source, "checkout", "-q", "-b", "fixes2", "v0.2.0");
    commitVersion(source, "0.2.0", "v0.2.0", "fix-020.txt");
    git(source, "checkout", "-q", "main");
    const r = await runInstall(home, source, "v0.2.0");
    assert.equal(r.state, "done", r.output);
    assert.equal(versionIn(home), "0.2.0");
    assert.ok(existsSync(join(home, "granted", "scaffold", "fix-020.txt")), "the re-tagged v0.2.0, not the stale local copy");
  });

  test("REGRESSION (review): updating stops a running Granted first — and waits until it has — so npm ci never runs under it", async () => {
    const source = makeSource();
    const home = freshHome();
    await runInstall(home, source, "v0.1.0");
    const tray = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", join(home, "granted", "scaffold", "scripts", "windows", "granted-tray.ps1"), "-NoTray", "-Port", String(PORT)],
      { windowsHide: true, stdio: "ignore", env: { ...process.env, LOCALAPPDATA: join(root, "LocalAppData") } },
    );
    started.push(tray);
    const deadline = Date.now() + 60_000;
    while ((await probeGranted(`http://127.0.0.1:${PORT}/`, 2000)) !== "granted" && Date.now() < deadline) await sleep(500);
    assert.equal(await probeGranted(`http://127.0.0.1:${PORT}/`, 2000), "granted", "Granted is running from the install");

    const r = await runInstall(home, source, "v0.2.0");
    assert.equal(r.state, "done", r.output);
    assert.match(r.output, /stopped the Granted that was running/);
    assert.ok(r.output.indexOf("stopped the Granted") < r.output.indexOf("Installing npm dependencies"), "stopped before npm ci");
    assert.notEqual(tray.exitCode, null, "the tray has exited");
    assert.equal(await probeGranted(`http://127.0.0.1:${PORT}/`, 1000), "down", "and its server with it");
    assert.equal(versionIn(home), "0.2.0");
  });

  /** Runs the installed copy's update.ps1 (what Settings → Update starts); returns its update-status.json. */
  async function runUpdater(home: string, source: string, ref: string, extra: string[] = []): Promise<{ state?: string; message?: string; from?: string; to?: string }> {
    const settings = join(root, `updater-${seq++}`, "settings.json");
    mkdirSync(join(settings, ".."), { recursive: true });
    await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", join(home, "granted", "scaffold", "scripts", "windows", "update.ps1"), "-Ref", ref, "-Port", String(PORT), ...extra],
      {
        windowsHide: true,
        timeout: 240_000,
        env: {
          ...process.env,
          GRANTED_INSTALL_SCRIPT: INSTALL_SCRIPT,
          GRANTED_REPO_URL: source,
          GRANTED_SETTINGS_PATH: settings,
          GRANTED_UNINSTALL_KEY_ROOT: `${keyParent}\\Uninstall`,
          LOCALAPPDATA: join(root, "LocalAppData"),
          npm_config_audit: "false",
          npm_config_fund: "false",
        },
      },
    ).catch(() => {});
    try {
      return JSON.parse(readFileSync(join(settings, "..", "update-status.json"), "utf8")) as { state?: string; message?: string };
    } catch {
      return {};
    }
  }
  const stopTestTray = async (home: string): Promise<void> => {
    await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", join(home, "granted", "scaffold", "scripts", "windows", "granted-tray.ps1"), "-Stop", "-Port", String(PORT)]).catch(() => {});
    const deadline = Date.now() + 30_000;
    while ((await probeGranted(`http://127.0.0.1:${PORT}/`, 1000)) !== "down" && Date.now() < deadline) await sleep(500);
  };

  test("update.ps1 (Settings → Update): stops the running Granted, updates to the release, and starts Granted again on its port", async () => {
    const source = makeSource();
    const home = freshHome();
    await runInstall(home, source, "v0.1.0");
    const tray = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", join(home, "granted", "scaffold", "scripts", "windows", "granted-tray.ps1"), "-NoTray", "-Port", String(PORT)],
      { windowsHide: true, stdio: "ignore", env: { ...process.env, LOCALAPPDATA: join(root, "LocalAppData") } },
    );
    started.push(tray);
    let deadline = Date.now() + 60_000;
    while ((await probeGranted(`http://127.0.0.1:${PORT}/`, 2000)) !== "granted" && Date.now() < deadline) await sleep(500);
    try {
      const status = await runUpdater(home, source, "v0.2.0");
      assert.equal(status.state, "done", JSON.stringify(status));
      assert.equal(status.from, "0.1.0");
      assert.equal(status.to, "v0.2.0");
      assert.equal(versionIn(home), "0.2.0");
      assert.notEqual(tray.exitCode, null, "the Granted that was running was stopped");
      // ...and started again, in the background, on the same port.
      deadline = Date.now() + 90_000;
      while ((await probeGranted(`http://127.0.0.1:${PORT}/`, 2000)) !== "granted" && Date.now() < deadline) await sleep(1000);
      assert.equal(await probeGranted(`http://127.0.0.1:${PORT}/`, 2000), "granted", "Granted is back");
    } finally {
      await stopTestTray(home);
    }
  });

  test("update.ps1: a failed update is reported (and the install left as it was); a declined one says why", async () => {
    const source = makeSource();
    const home = freshHome();
    await runInstall(home, source, "v0.1.0");
    const missing = await runUpdater(home, source, "v0.9.9", ["-NoRestart"]);
    assert.equal(missing.state, "error", JSON.stringify(missing));
    assert.match(missing.message ?? "", /didn't finish/);
    assert.equal(versionIn(home), "0.1.0");

    // REGRESSION (review): declined BEFORE anything is stopped -- a running Granted keeps running.
    writeFileSync(join(home, "granted", "scaffold", "server.js"), readFileSync(join(home, "granted", "scaffold", "server.js"), "utf8") + "\n// my change\n");
    const tray = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", join(home, "granted", "scaffold", "scripts", "windows", "granted-tray.ps1"), "-NoTray", "-Port", String(PORT)],
      { windowsHide: true, stdio: "ignore", env: { ...process.env, LOCALAPPDATA: join(root, "LocalAppData") } },
    );
    started.push(tray);
    const deadline = Date.now() + 60_000;
    while ((await probeGranted(`http://127.0.0.1:${PORT}/`, 2000)) !== "granted" && Date.now() < deadline) await sleep(500);
    try {
      const declined = await runUpdater(home, source, "v0.2.0", ["-NoRestart"]);
      assert.equal(declined.state, "error", JSON.stringify(declined));
      assert.match(declined.message ?? "", /wasn't updated to v0\.2\.0: it has local changes/);
      assert.equal(versionIn(home), "0.1.0");
      assert.equal(tray.exitCode, null, "the running Granted wasn't stopped for a declined update");
      assert.equal(await probeGranted(`http://127.0.0.1:${PORT}/`, 2000), "granted");
    } finally {
      await stopTestTray(home);
    }

    const bad = await runUpdater(home, source, "main", ["-NoRestart"]);
    assert.equal(bad.state, "error");
    assert.match(bad.message ?? "", /must be a release tag/);
  });

  test("REGRESSION (review): update.ps1 puts the previous version back when the update fails half-way (npm ci)", async () => {
    const source = makeSource();
    // v0.2.1: a release whose npm ci fails (lockfile out of sync with package.json).
    git(source, "checkout", "-q", "-b", "broken", "v0.2.0");
    writeFileSync(
      join(source, "scaffold", "package.json"),
      JSON.stringify({ name: "granted", version: "0.2.1", private: true, scripts: { dev: "node server.js" }, dependencies: { "left-pad": "1.3.0" } }, null, 2),
    );
    git(source, "add", "-A");
    git(source, "commit", "-q", "-m", "broken 0.2.1");
    git(source, "tag", "-a", "v0.2.1", "-m", "v0.2.1");
    git(source, "checkout", "-q", "main");
    const home = freshHome();
    await runInstall(home, source, "v0.1.0");
    const status = await runUpdater(home, source, "v0.2.1", ["-NoRestart"]);
    assert.equal(status.state, "error", JSON.stringify(status));
    assert.match(status.message ?? "", /The update to v0\.2\.1 didn't finish: .*Granted v0\.1\.0 was put back\. Details are in /);
    assert.doesNotMatch(status.message ?? "", /see the output above/);
    assert.equal(versionIn(home), "0.1.0");
    assert.equal(git(join(home, "granted"), "describe", "--tags", "--exact-match"), "v0.1.0");
    // ("was put back" is only said once the restore's npm ci succeeded.)
  });

  test("REGRESSION (review): the app's real startUpdater launches update.ps1, which outlives the server that started it", async () => {
    // A stand-in update.ps1 that records how it was started, waits, then
    // records that it finished -- after its "server" has been killed.
    const dir = join(root, `launch-${seq++}`, "scaffold");
    mkdirSync(join(dir, "scripts", "windows"), { recursive: true });
    const startedFile = join(dir, "started.txt");
    const finishedFile = join(dir, "finished.txt");
    const q = (p: string): string => `'${p.replace(/'/g, "''")}'`;
    writeFileSync(
      join(dir, "scripts", "windows", "update.ps1"),
      `param([string]$Ref, [int]$Port)\r\nSet-Content -LiteralPath ${q(startedFile)} -Value "$Ref $Port"\r\nStart-Sleep -Seconds 6\r\nSet-Content -LiteralPath ${q(finishedFile)} -Value done\r\n`,
    );
    // The "server": a node process calling the app's real startUpdater (scaffold/lib/appUpdate/install.ts).
    const installTs = resolve(REPO_ROOT, "scaffold", "lib", "appUpdate", "install.ts").replace(/\\/g, "/");
    const serverScript = join(dir, "server.mts");
    writeFileSync(
      serverScript,
      `import { startUpdater } from "file:///${installTs}";\nawait startUpdater("v9.9.9", 3456, ${JSON.stringify(join(dir, "scripts", "windows", "update.ps1"))}, { dir: ${JSON.stringify(dir)} });\nconsole.log("launched");\nsetInterval(() => {}, 1000);\n`,
    );
    const server = spawn(process.execPath, ["--import", "tsx", serverScript], { cwd: process.cwd(), windowsHide: true, stdio: ["ignore", "pipe", "inherit"] });
    started.push(server);
    let out = "";
    server.stdout?.on("data", (b: Buffer) => (out += b.toString()));
    let deadline = Date.now() + 60_000;
    while (!existsSync(startedFile) && Date.now() < deadline) await sleep(250);
    assert.ok(existsSync(startedFile), "update.ps1 was actually started");
    assert.match(readFileSync(startedFile, "utf8"), /v9\.9\.9 3456/);
    // The update stops the server (its whole tree): the updater must survive that.
    execFileSync("taskkill.exe", ["/PID", String(server.pid), "/T", "/F"], { stdio: "ignore" });
    deadline = Date.now() + 30_000;
    while (!existsSync(finishedFile) && Date.now() < deadline) await sleep(250);
    assert.ok(existsSync(finishedFile), "update.ps1 ran to the end after its server was killed");
    assert.match(out, /launched/);
  });

  test("a folder the installer didn't make (someone's own checkout) is never switched to another release", async () => {
    const source = makeSource();
    const home = freshHome();
    git(home, "clone", "-q", "--branch", "v0.1.0", source, "granted");
    const r = await runInstall(home, source, "v0.2.0");
    assert.equal(r.state, "done", r.output);
    assert.match(r.output, /wasn't installed by this installer/);
    assert.equal(versionIn(home), "0.1.0");
  });

  test("REGRESSION (review): a release that can't be checked out leaves no half-made folder behind, so a re-run works", async () => {
    const source = makeSource();
    const home = freshHome();
    const r = await runInstall(home, source, "v0.9.9"); // no such release
    assert.equal(r.state, "error");
    assert.match(r.message ?? "", /Couldn't check out Granted v0\.9\.9/);
    assert.equal(existsSync(join(home, "granted")), false, "the clone it just made is gone");
    const retry = await runInstall(home, source, "v0.1.0");
    assert.equal(retry.state, "done", retry.output);
    assert.equal(versionIn(home), "0.1.0");
  });

  test("a GRANTED_REF that isn't a release tag is refused before anything is done", async () => {
    const home = freshHome();
    const r = await runInstall(home, makeSource(), "main; Remove-Item x");
    assert.equal(r.state, "error");
    assert.match(r.message ?? "", /must be a release tag/);
    assert.equal(existsSync(join(home, "granted")), false);
  });
});
