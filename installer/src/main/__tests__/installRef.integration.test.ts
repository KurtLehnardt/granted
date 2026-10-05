/**
 * Integration: the REAL install-windows.ps1 installing a specific release
 * (GRANTED_REF) — what the downloadable Granted-Setup-x.y.z.exe asks for —
 * from a local stand-in repo (GRANTED_REPO_URL) with two release tags, so it
 * runs offline and fast. Covers a fresh pinned install, updating an install
 * this script made, and leaving alone a folder with local changes or one it
 * didn't make. Git and Node must already be installed (they are wherever
 * this runs), so nothing is downloaded. Registry, LOCALAPPDATA and the port
 * the tray is stopped on are all test-only. Windows only.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { readStatusFile } from "../openGranted";

const execFileAsync = promisify(execFile);
const REPO_ROOT = resolve(process.cwd(), "..");
const INSTALL_SCRIPT = join(REPO_ROOT, "install-windows.ps1");
const WINDOWS_SCRIPTS = join(REPO_ROOT, "scaffold", "scripts", "windows");

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.com", "-c", "advice.detachedHead=false", ...args], {
    cwd,
    encoding: "utf8",
    windowsHide: true,
  }).trim();

describe("install-windows.ps1 with GRANTED_REF (a pinned release)", { skip: (process.platform !== "win32" || !existsSync(INSTALL_SCRIPT)) && "Windows only, run from installer/" }, () => {
  let root: string;
  let source: string;
  const keyParent = `HKCU:\\Software\\GrantedTests\\${randomUUID()}`;
  let seq = 0;

  function commitVersion(version: string): void {
    const scaffold = join(source, "scaffold");
    writeFileSync(join(scaffold, "package.json"), JSON.stringify({ name: "granted", version, private: true }, null, 2));
    writeFileSync(
      join(scaffold, "package-lock.json"),
      JSON.stringify({ name: "granted", version, lockfileVersion: 3, requires: true, packages: { "": { name: "granted", version } } }, null, 2),
    );
    git(source, "add", "-A");
    git(source, "commit", "-q", "-m", `version ${version}`);
    git(source, "tag", `v${version}`);
  }

  /** Runs the real script in its own folder under root; returns its status and console output. */
  async function runInstall(dir: string, ref: string | null): Promise<{ state: string | null; message: string | null; output: string }> {
    const status = join(root, `status-${seq++}.json`);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      GRANTED_REPO_URL: source,
      GRANTED_INSTALL_DIR: "granted",
      GRANTED_STATUS_FILE: status,
      GRANTED_UNINSTALL_KEY_ROOT: `${keyParent}\\Uninstall`,
      LOCALAPPDATA: join(root, "LocalAppData"),
      GRANTED_SETTINGS_PATH: join(root, "LocalAppData", "Granted", "settings.json"),
      // The re-run stops a running tray on GRANTED_PORT: never a real Granted's.
      GRANTED_PORT: "3979",
      npm_config_audit: "false",
      npm_config_fund: "false",
    };
    if (ref) env["GRANTED_REF"] = ref;
    else delete env["GRANTED_REF"];
    let output = "";
    try {
      const r = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", INSTALL_SCRIPT], {
        cwd: dir,
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

  const versionIn = (dir: string): string => (JSON.parse(readFileSync(join(dir, "granted", "scaffold", "package.json"), "utf8")) as { version: string }).version;
  const freshDir = (): string => {
    const d = join(root, `home-${seq++}`);
    mkdirSync(d, { recursive: true });
    return d;
  };

  before(async () => {
    root = await mkdtemp(join(tmpdir(), "granted-installref-it-"));
    source = join(root, "source");
    const windows = join(source, "scaffold", "scripts", "windows");
    mkdirSync(windows, { recursive: true });
    for (const f of readdirSync(WINDOWS_SCRIPTS)) copyFileSync(join(WINDOWS_SCRIPTS, f), join(windows, f));
    git(source, "init", "-q");
    commitVersion("0.1.0");
    commitVersion("0.2.0");
  });

  after(async () => {
    await execFileAsync("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `Remove-Item -Path '${keyParent}' -Recurse -Force -ErrorAction SilentlyContinue; if (-not (Get-ChildItem 'HKCU:\\Software\\GrantedTests' -ErrorAction SilentlyContinue)) { Remove-Item 'HKCU:\\Software\\GrantedTests' -Force -ErrorAction SilentlyContinue }`,
    ]).catch(() => {});
    await rm(root, { recursive: true, force: true }).catch(() => {});
  });

  test("a fresh install of v0.1.0 gets exactly v0.1.0 (not the newer v0.2.0), marked as installer-made, and listed at that version", async () => {
    const home = freshDir();
    const r = await runInstall(home, "v0.1.0");
    assert.equal(r.state, "done", r.output);
    assert.equal(versionIn(home), "0.1.0");
    assert.equal(git(join(home, "granted"), "describe", "--tags", "--exact-match"), "v0.1.0");
    assert.ok(existsSync(join(home, "granted", ".git", "granted-installer")), "marked as made by the installer");
    const listed = execFileSync("powershell.exe", ["-NoProfile", "-Command", `(Get-ChildItem '${keyParent}\\Uninstall' | Get-ItemProperty).DisplayVersion`], { encoding: "utf8" }).trim();
    assert.equal(listed, "0.1.0");

    // Then the installer is run again asking for v0.2.0 (a newer release): updated in place.
    const update = await runInstall(home, "v0.2.0");
    assert.equal(update.state, "done", update.output);
    assert.equal(versionIn(home), "0.2.0");
    assert.match(update.output, /now at v0\.2\.0/);
    const relisted = execFileSync("powershell.exe", ["-NoProfile", "-Command", `(Get-ChildItem '${keyParent}\\Uninstall' | Get-ItemProperty).DisplayVersion`], { encoding: "utf8" }).trim();
    assert.equal(relisted, "0.2.0", "Installed apps shows the new version");

    // Local changes: never switched over them.
    writeFileSync(join(home, "granted", "scaffold", "package.json"), readFileSync(join(home, "granted", "scaffold", "package.json"), "utf8") + "\n");
    const kept = await runInstall(home, "v0.1.0");
    assert.equal(kept.state, "done", kept.output);
    assert.match(kept.output, /has local changes/);
    assert.equal(versionIn(home), "0.2.0");
  });

  test("a folder the installer didn't make (someone's own checkout) is never switched to another release", async () => {
    const home = freshDir();
    git(home, "clone", "-q", "--branch", "v0.1.0", source, "granted");
    const r = await runInstall(home, "v0.2.0");
    assert.equal(r.state, "done", r.output);
    assert.match(r.output, /wasn't installed by this installer/);
    assert.equal(versionIn(home), "0.1.0");
  });

  test("a GRANTED_REF that isn't a release tag is refused before anything is done", async () => {
    const home = freshDir();
    const r = await runInstall(home, "main; Remove-Item x");
    assert.equal(r.state, "error");
    assert.match(r.message ?? "", /must be a release tag/);
    assert.equal(existsSync(join(home, "granted")), false);
  });
});
