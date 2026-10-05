/**
 * Integration: the REAL scaffold/scripts/windows/uninstall.ps1, run by a real
 * powershell.exe against throwaway Granted installs — registering the
 * Installed apps entry, and uninstalling (tray + server, shortcuts, the
 * folder including paths past 260 characters and read-only git files, the
 * entry, app data). Every run points the script at a test registry key
 * (HKCU\Software\GrantedTests\…), test shortcut folders and a test settings
 * file, so the real Installed apps list, Desktop and Start menu are never
 * touched. Windows only (on CI: the installer-windows job).
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { probeGranted } from "../openGranted";

const execFileAsync = promisify(execFile);

const WINDOWS_SCRIPTS = resolve(process.cwd(), "..", "scaffold", "scripts", "windows");
const PS = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File"];
const GRANTED_HTML = "<title>Granted — federal funding intelligence for everyone</title>";
const FAKE_SERVER = `require("node:http").createServer((q, r) => r.end(${JSON.stringify(GRANTED_HTML)})).listen(Number(process.env.PORT), "127.0.0.1");`;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function until<T>(fn: () => Promise<T>, ok: (v: T) => boolean, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last = await fn();
  while (!ok(last) && Date.now() < deadline) {
    await sleep(250);
    last = await fn();
  }
  return last;
}

/** Runs a PowerShell snippet and returns stdout (via -EncodedCommand: no quoting games). */
async function ps(script: string): Promise<string> {
  const encoded = Buffer.from(`$ProgressPreference = 'SilentlyContinue'\n${script}`, "utf16le").toString("base64");
  return (await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], { windowsHide: true })).stdout;
}
const psq = (s: string): string => `'${s.replace(/'/g, "''")}'`;

test("install-windows.ps1 registers the Installed apps entry at the end of an install, without failing the install over it", { skip: !existsSync(WINDOWS_SCRIPTS) && "run from installer/" }, () => {
  const install = readFileSync(resolve(process.cwd(), "..", "install-windows.ps1"), "utf8");
  const step = install.slice(install.indexOf("npm ci"), install.indexOf('Write-Status "done"'));
  assert.match(step, /scripts\\windows\\uninstall\.ps1/);
  assert.match(step, /-Register -InstallDir/);
  assert.match(step, /try \{[\s\S]*-Register[\s\S]*\} catch \{[\s\S]*Warn/);
});

describe("uninstall.ps1: the Installed apps entry, and uninstalling", { skip: (process.platform !== "win32" || !existsSync(WINDOWS_SCRIPTS)) && "Windows only, run from installer/" }, () => {
  let root: string;
  // A test-only registry key; deleted, with everything under it, at the end.
  const testKeyParent = `HKCU:\\Software\\GrantedTests\\${randomUUID()}`;
  const keyRoot = `${testKeyParent}\\Uninstall`;
  const started: ChildProcess[] = [];
  let nextPort = 3981;
  let seq = 0;

  interface Box {
    installDir: string;
    scaffold: string;
    desktop: string;
    startMenu: string;
    settings: string;
    env: NodeJS.ProcessEnv;
  }

  /** A throwaway install (a fake Granted clone with the real Windows scripts) plus its own test folders. */
  function makeBox(opts: { name?: string; packageName?: string } = {}): Box {
    const base = join(root, `box-${seq++}`);
    const installDir = join(base, opts.name ?? "granted-test-install");
    const scaffold = join(installDir, "scaffold");
    const windows = join(scaffold, "scripts", "windows");
    mkdirSync(windows, { recursive: true });
    for (const f of readdirSync(WINDOWS_SCRIPTS)) copyFileSync(join(WINDOWS_SCRIPTS, f), join(windows, f));
    writeFileSync(
      join(scaffold, "package.json"),
      JSON.stringify({ name: opts.packageName ?? "granted", version: "9.9.9", private: true, scripts: { dev: "node fake-dev.js" } }),
    );
    writeFileSync(join(scaffold, "fake-dev.js"), FAKE_SERVER);
    writeFileSync(join(scaffold, ".env.local"), "OPENAI_API_KEY=sk-uninstall-test-0000000000\nANTHROPIC_API_KEY=sk-ant-...\n");
    // What a real clone has that's hard to delete: a git object file (read-only)...
    mkdirSync(join(installDir, ".git", "objects", "ab"), { recursive: true });
    const obj = join(installDir, ".git", "objects", "ab", "cdef0123");
    writeFileSync(obj, "x");
    chmodSync(obj, 0o444);
    // ...and node_modules nesting past Windows' old 260-character path limit.
    let deep = join(scaffold, "node_modules");
    while (deep.length < 300) deep = join(deep, "some-very-long-package-name-segment");
    mkdirSync(`\\\\?\\${deep}`, { recursive: true });
    writeFileSync(`\\\\?\\${join(deep, "index.js")}`, "module.exports = 1;");
    const settings = join(base, "LocalAppData", "Granted", "settings.json");
    mkdirSync(join(base, "LocalAppData", "Granted", "logs"), { recursive: true });
    writeFileSync(settings, JSON.stringify({ openIn: "window" }));
    const desktop = join(base, "Desktop");
    const startMenu = join(base, "Programs");
    return {
      installDir,
      scaffold,
      desktop,
      startMenu,
      settings,
      env: {
        ...process.env,
        GRANTED_UNINSTALL_KEY_ROOT: keyRoot,
        GRANTED_SETTINGS_PATH: settings,
        GRANTED_SHORTCUT_DESKTOP_DIR: desktop,
        GRANTED_SHORTCUT_STARTMENU_DIR: startMenu,
      },
    };
  }

  const scriptIn = (box: Box, name: string): string => join(box.scaffold, "scripts", "windows", name);

  /** Runs uninstall.ps1 from inside the box; returns its exit code and parsed JSON line. */
  async function uninstall(box: Box, args: string[]): Promise<{ code: number; result: Record<string, unknown> }> {
    try {
      const { stdout } = await execFileAsync("powershell.exe", [...PS, scriptIn(box, "uninstall.ps1"), ...args], { windowsHide: true, env: box.env });
      return { code: 0, result: JSON.parse(stdout.trim().split(/\r?\n/).pop() ?? "{}") };
    } catch (err) {
      const e = err as { code?: number; stdout?: string };
      let result: Record<string, unknown> = {};
      try {
        result = JSON.parse((e.stdout ?? "").trim().split(/\r?\n/).pop() ?? "{}");
      } catch {
        /* no JSON: a throw */
      }
      return { code: e.code ?? -1, result };
    }
  }

  async function entries(): Promise<Array<Record<string, unknown>>> {
    const out = await ps(
      `if (Test-Path ${psq(keyRoot)}) { @(Get-ChildItem ${psq(keyRoot)} | ForEach-Object { $p = Get-ItemProperty $_.PSPath; $p | Add-Member -NotePropertyName KeyName -NotePropertyValue $_.PSChildName -PassThru }) | ConvertTo-Json -Depth 3 -Compress } else { '[]' }`,
    );
    const parsed = JSON.parse(out.trim() || "[]") as Record<string, unknown> | Array<Record<string, unknown>>;
    return Array.isArray(parsed) ? parsed : [parsed];
  }
  const entryFor = async (box: Box): Promise<Record<string, unknown> | undefined> =>
    (await entries()).find((e) => String(e["InstallLocation"]).toLowerCase() === box.installDir.toLowerCase());

  before(async () => {
    root = await mkdtemp(join(tmpdir(), "granted-uninstall-it-"));
  });

  after(async () => {
    for (const c of started) if (c.exitCode === null) c.kill();
    await ps(`Remove-Item -Path ${psq(testKeyParent)} -Recurse -Force -ErrorAction SilentlyContinue; if (-not (Get-ChildItem 'HKCU:\\Software\\GrantedTests' -ErrorAction SilentlyContinue)) { Remove-Item 'HKCU:\\Software\\GrantedTests' -Force -ErrorAction SilentlyContinue }`);
    await rm(root, { recursive: true, force: true }).catch(() => {});
  });

  test("-Register adds an Installed apps entry: name, version, icon, folder, size, and how to uninstall (hidden, and quietly)", async () => {
    const box = makeBox({ name: "granted-reg" });
    const { code, result } = await uninstall(box, ["-Register"]);
    assert.equal(code, 0);
    assert.equal(result["registered"], true);
    const e = await entryFor(box);
    assert.ok(e, "an entry for this folder");
    assert.match(String(e["KeyName"]), /^Granted-[0-9a-f]{12}$/);
    assert.equal(e["DisplayName"], "Granted (granted-reg)", "a folder other than ~\\granted says which it is");
    assert.equal(e["DisplayVersion"], "9.9.9");
    assert.equal(e["Publisher"], "Granted");
    assert.match(String(e["DisplayIcon"]), /\\scaffold\\scripts\\windows\\granted\.ico$/);
    assert.equal(e["NoModify"], 1);
    assert.equal(e["NoRepair"], 1);
    assert.ok(Number(e["EstimatedSize"]) > 0, "a size for Installed apps to show");
    assert.match(String(e["InstallDate"]), /^\d{8}$/);
    const uninstallString = String(e["UninstallString"]);
    assert.match(uninstallString, /^"[^"]*\\System32\\conhost\.exe" --headless "[^"]*powershell\.exe" -NoProfile -STA -ExecutionPolicy Bypass -File "[^"]*\\scripts\\windows\\uninstall\.ps1"$/);
    assert.ok(uninstallString.toLowerCase().includes(box.installDir.toLowerCase()), "it runs THIS install's uninstaller");
    assert.equal(e["QuietUninstallString"], `${uninstallString} -Quiet`);
  });

  test("-Register again refreshes the same entry rather than adding a second", async () => {
    const box = makeBox();
    await uninstall(box, ["-Register"]);
    await uninstall(box, ["-Register"]);
    assert.equal((await entries()).filter((e) => String(e["InstallLocation"]).toLowerCase() === box.installDir.toLowerCase()).length, 1);
  });

  test("-Register refuses a folder that isn't a Granted install, and writes nothing", async () => {
    const box = makeBox({ packageName: "something-else" });
    const { code } = await uninstall(box, ["-Register"]);
    assert.notEqual(code, 0);
    assert.equal(await entryFor(box), undefined);
  });

  test("-Quiet uninstall: quits the running tray and server, removes this install's shortcuts, the folder (long paths, read-only files), the entry and app data — keeping a copy of the keys when asked", async () => {
    const box = makeBox();
    await uninstall(box, ["-Register"]);
    await execFileAsync("powershell.exe", [...PS, scriptIn(box, "shortcuts.ps1"), "-Desktop", "-StartMenu", "-DesktopDir", box.desktop, "-StartMenuDir", box.startMenu], { windowsHide: true });
    const port = nextPort++;
    const tray = spawn("powershell.exe", [...PS, scriptIn(box, "granted-tray.ps1"), "-NoTray", "-Port", String(port)], { windowsHide: true, stdio: "ignore", env: box.env });
    started.push(tray);
    assert.equal(await until(() => probeGranted(`http://127.0.0.1:${port}/`, 2000), (p) => p === "granted"), "granted");

    // Every other registered Granted install must be gone for app data to go too.
    for (const e of await entries()) if (String(e["InstallLocation"]).toLowerCase() !== box.installDir.toLowerCase()) {
      await ps(`Remove-Item -Path ${psq(`${keyRoot}\\${String(e["KeyName"])}`)} -Recurse -Force`);
    }

    const backup = join(root, "kept-keys.env.local.txt");
    const { code, result } = await uninstall(box, ["-Quiet", "-KeepKeys", "-KeysBackupPath", backup]);
    assert.equal(code, 0, JSON.stringify(result));
    assert.equal(result["removed"], true);
    assert.equal(existsSync(box.installDir), false, "the whole folder is gone");
    assert.equal(result["leftover"] ?? null, null, "nothing left behind");
    assert.equal(readdirSync(join(box.installDir, "..")).some((n) => n.includes(".uninstalling-")), false);
    if (tray.exitCode === null) await new Promise((r) => tray.once("exit", r)); // the tray quit (or this times out)
    assert.equal(await probeGranted(`http://127.0.0.1:${port}/`, 1000), "down", "and its server with it");
    assert.equal(existsSync(join(box.desktop, "Granted.lnk")), false);
    assert.equal(existsSync(join(box.startMenu, "Granted.lnk")), false);
    assert.equal(await entryFor(box), undefined, "the Installed apps entry is gone");
    assert.match(readFileSync(backup, "utf8"), /^OPENAI_API_KEY=sk-uninstall-test-0000000000$/m, "the keys were kept");
    assert.equal(result["keptKeys"], backup);
    assert.equal(existsSync(join(box.settings, "..")), false, "the last install out takes the settings and logs with it");
  });

  test("another install's shortcut and the shared settings stay while another Granted is still registered", async () => {
    const box = makeBox();
    const other = makeBox({ name: "granted-other" });
    await uninstall(box, ["-Register"]);
    await uninstall(other, ["-Register"]);
    // The other install's shortcut sits where this one's would.
    await execFileAsync("powershell.exe", [...PS, scriptIn(other, "shortcuts.ps1"), "-Desktop", "-DesktopDir", box.desktop], { windowsHide: true });
    const { code } = await uninstall(box, ["-Quiet"]);
    assert.equal(code, 0);
    assert.equal(existsSync(box.installDir), false);
    assert.equal(existsSync(join(box.desktop, "Granted.lnk")), true, "not this install's shortcut: left alone");
    assert.equal(existsSync(box.settings), true, "another Granted is still installed: settings stay");
    assert.ok(await entryFor(other), "and its entry stays");
  });

  test("without -KeepKeys, -Quiet keeps no copy of the keys", async () => {
    const box = makeBox();
    const backup = join(root, "should-not-exist.txt");
    const { code, result } = await uninstall(box, ["-Quiet", "-KeysBackupPath", backup]);
    assert.equal(code, 0);
    assert.equal(existsSync(backup), false);
    assert.equal(result["keptKeys"] ?? null, null);
  });

  test("a folder that isn't a Granted install is never deleted (exit 2)", async () => {
    const box = makeBox({ packageName: "my-own-project" });
    const { code, result } = await uninstall(box, ["-Quiet"]);
    assert.equal(code, 2);
    assert.equal(result["reason"], "not-a-granted-install");
    assert.equal(existsSync(join(box.scaffold, "package.json")), true);
  });

  test("a folder deleted by hand: the stale entry is just removed", async () => {
    const box = makeBox();
    await uninstall(box, ["-Register"]);
    // The uninstaller has to come from somewhere once the folder is gone: run a copy.
    const copy = join(root, `uninstall-copy-${seq++}.ps1`);
    copyFileSync(scriptIn(box, "uninstall.ps1"), copy);
    await rm(box.installDir, { recursive: true, force: true });
    const { stdout } = await execFileAsync("powershell.exe", [...PS, copy, "-Quiet", "-InstallDir", box.installDir], { windowsHide: true, env: box.env });
    assert.equal(JSON.parse(stdout.trim())["alreadyGone"], true);
    assert.equal(await entryFor(box), undefined);
  });

  test("files still in use: reports it (exit 3) and keeps the entry, so it can be retried", async () => {
    const box = makeBox();
    await uninstall(box, ["-Register"]);
    // Something that isn't Granted's (so it isn't stopped) holding a folder inside as its working directory.
    // (ping itself, not via cmd: killing a cmd would orphan its ping, still holding the folder.)
    const holder = spawn("ping.exe", ["-n", "120", "127.0.0.1"], { cwd: join(box.scaffold, "scripts"), windowsHide: true, stdio: "ignore" });
    started.push(holder);
    await sleep(500);
    try {
      const { code, result } = await uninstall(box, ["-Quiet"]);
      assert.equal(code, 3);
      assert.equal(result["reason"], "files-in-use");
      assert.ok(await entryFor(box), "the entry stays for a retry");
      assert.equal(existsSync(join(box.scaffold, "package.json")), true, "nothing was deleted: still a whole, retryable install");
      assert.equal(existsSync(join(box.scaffold, ".env.local")), true);
    } finally {
      const gone = holder.exitCode === null ? new Promise((r) => holder.once("exit", r)) : Promise.resolve();
      holder.kill();
      await gone;
    }
    const retry = await uninstall(box, ["-Quiet"]);
    assert.equal(retry.code, 0, "once nothing holds it, uninstalling again works");
    assert.equal(existsSync(box.installDir), false);
    assert.equal(await entryFor(box), undefined);
  });
});
