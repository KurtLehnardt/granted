/**
 * Integration: the REAL scaffold/scripts/windows/uninstall.ps1, run by a real
 * powershell.exe against throwaway Granted installs — registering the
 * Installed apps entry, and uninstalling (tray + server, shortcuts, the
 * folder including paths past 260 characters and read-only git files, the
 * entry, app data), plus everything it must refuse to delete. Every run
 * points the script at a test registry key (HKCU\Software\GrantedTests\…)
 * and gives it a test LOCALAPPDATA, settings file and shortcut folders, so
 * the real Installed apps list, Desktop, Start menu and %LOCALAPPDATA%\Granted
 * are never touched. Windows only (on CI: the installer-windows job).
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync, spawn, type ChildProcess } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
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
/** Resolves once the process has exited; fails (rather than hanging the suite) after timeoutMs. */
function exited(child: ChildProcess, timeoutMs = 30_000): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((res, rej) => {
    const timer = setTimeout(() => rej(new Error(`process ${child.pid} didn't exit within ${timeoutMs} ms`)), timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      res();
    });
  });
}

/** Runs a PowerShell snippet and returns stdout (via -EncodedCommand: no quoting games). */
async function ps(script: string): Promise<string> {
  const encoded = Buffer.from(`$ProgressPreference = 'SilentlyContinue'\n${script}`, "utf16le").toString("base64");
  return (await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], { windowsHide: true })).stdout;
}
const psq = (s: string): string => `'${s.replace(/'/g, "''")}'`;
const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.com", ...args], { cwd, encoding: "utf8", windowsHide: true });

test("install-windows.ps1 marks the clones it makes, and registers at the end without failing the install over it", { skip: !existsSync(WINDOWS_SCRIPTS) && "run from installer/" }, () => {
  const install = readFileSync(resolve(process.cwd(), "..", "install-windows.ps1"), "utf8");
  const clone = install.slice(install.indexOf("git clone $RepoUrl"), install.indexOf('Ok "cloned"'));
  assert.match(clone, /\.git\\granted-installer/, "the marker is written right after a fresh clone (only)");
  const step = install.slice(install.indexOf("npm ci"), install.indexOf('Write-Status "done"'));
  assert.match(step, /scripts\\windows\\uninstall\.ps1/);
  assert.match(step, /-Register -InstallDir/);
  assert.match(step, /Test-Path -LiteralPath \$uninstallScript/, "brackets in the folder name don't break the check");
  assert.match(step, /not-made-by-installer/, "says why a pre-existing folder isn't listed");
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
    /** installDir's long form (%TEMP% can be an 8.3 short path, e.g. RUNNER~1 on CI): what the entry records. */
    canonical: string;
    scaffold: string;
    localAppData: string;
    appData: string;
    desktop: string;
    startMenu: string;
    env: NodeJS.ProcessEnv;
  }

  /** A throwaway install (a fake Granted clone with the real Windows scripts) plus its own test folders. */
  function makeBox(opts: { name?: string; parent?: string; packageName?: string; marker?: boolean; sharedWith?: Box } = {}): Box {
    const base = join(root, opts.parent ?? `box-${seq++}`);
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
    writeFileSync(join(scaffold, ".env.local"), "OPENAI_API_KEY=sk-uninstall-test-0000000000\nLLM_API_KEY=sk-only-here-0000000000\n");
    mkdirSync(join(scaffold, "data", "local"), { recursive: true });
    writeFileSync(join(scaffold, "data", "local", "llm-config.json"), JSON.stringify({ cloud: { apiKey: "sk-in-settings-0000000000" } }));
    // What a real clone has that's hard to delete: a git object file (read-only)...
    mkdirSync(join(installDir, ".git", "objects", "ab"), { recursive: true });
    const obj = join(installDir, ".git", "objects", "ab", "cdef0123");
    writeFileSync(obj, "x");
    chmodSync(obj, 0o444);
    if (opts.marker !== false) writeFileSync(join(installDir, ".git", "granted-installer"), "test");
    // ...and node_modules nesting past Windows' old 260-character path limit.
    let deep = join(scaffold, "node_modules");
    while (deep.length < 300) deep = join(deep, "some-very-long-package-name-segment");
    mkdirSync(`\\\\?\\${deep}`, { recursive: true });
    writeFileSync(`\\\\?\\${join(deep, "index.js")}`, "module.exports = 1;");
    // Each box its own LOCALAPPDATA (the tray's logs, the settings, the
    // uninstaller copies) -- unless it shares one, as two installs on one machine do.
    const localAppData = opts.sharedWith?.localAppData ?? join(base, "LocalAppData");
    const appData = join(localAppData, "Granted");
    mkdirSync(join(appData, "logs"), { recursive: true });
    writeFileSync(join(appData, "settings.json"), JSON.stringify({ openIn: "window" }));
    const desktop = opts.sharedWith?.desktop ?? join(base, "Desktop");
    const startMenu = opts.sharedWith?.startMenu ?? join(base, "Programs");
    return {
      installDir,
      canonical: realpathSync.native(installDir),
      scaffold,
      localAppData,
      appData,
      desktop,
      startMenu,
      env: {
        ...process.env,
        LOCALAPPDATA: localAppData,
        GRANTED_UNINSTALL_KEY_ROOT: keyRoot,
        GRANTED_SETTINGS_PATH: join(appData, "settings.json"),
        GRANTED_SHORTCUT_DESKTOP_DIR: desktop,
        GRANTED_SHORTCUT_STARTMENU_DIR: startMenu,
      },
    };
  }

  const scriptIn = (box: Box, name: string): string => join(box.scaffold, "scripts", "windows", name);
  const parseLast = (stdout: string | undefined): Record<string, unknown> => {
    try {
      return JSON.parse((stdout ?? "").trim().split(/\r?\n/).pop() ?? "{}") as Record<string, unknown>;
    } catch {
      return {};
    }
  };

  /** Runs uninstall.ps1 (from inside the box unless `script` says otherwise); returns its exit code and JSON line. */
  async function uninstall(box: Box, args: string[], script = scriptIn(box, "uninstall.ps1")): Promise<{ code: number; result: Record<string, unknown> }> {
    try {
      const { stdout } = await execFileAsync("powershell.exe", [...PS, script, ...args], { windowsHide: true, env: box.env });
      return { code: 0, result: parseLast(stdout) };
    } catch (err) {
      const e = err as { code?: number; stdout?: string };
      return { code: e.code ?? -1, result: parseLast(e.stdout) };
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
    (await entries()).find((e) => String(e["InstallLocation"]).toLowerCase() === box.canonical.toLowerCase());
  /** Removes every entry but this box's (app data only goes with the last registered install). */
  async function onlyEntry(box: Box): Promise<void> {
    for (const e of await entries()) {
      if (String(e["InstallLocation"]).toLowerCase() !== box.canonical.toLowerCase()) {
        await ps(`Remove-Item -Path ${psq(`${keyRoot}\\${String(e["KeyName"])}`)} -Recurse -Force`);
      }
    }
  }
  /** The script Installed apps actually runs: the copy named in the entry's UninstallString. */
  function uninstallerCopy(entry: Record<string, unknown>): string {
    const m = /-File "([^"]+)"/.exec(String(entry["UninstallString"]));
    assert.ok(m, "UninstallString names a script");
    return m[1];
  }

  before(async () => {
    root = await mkdtemp(join(tmpdir(), "granted-uninstall-it-"));
  });

  after(async () => {
    for (const c of started) if (c.exitCode === null) c.kill();
    // (A run filtered to tests that never register has no key to remove: fine.)
    await ps(`Remove-Item -Path ${psq(testKeyParent)} -Recurse -Force -ErrorAction SilentlyContinue; if (-not (Get-ChildItem 'HKCU:\\Software\\GrantedTests' -ErrorAction SilentlyContinue)) { Remove-Item 'HKCU:\\Software\\GrantedTests' -Force -ErrorAction SilentlyContinue }; exit 0`).catch(() => {});
    await rm(root, { recursive: true, force: true }).catch(() => {});
  });

  test("-Register adds an Installed apps entry: name, version, icon, folder, size, and an uninstaller kept OUTSIDE the folder", async () => {
    const box = makeBox({ name: "granted-reg" });
    const { code, result } = await uninstall(box, ["-Register"]);
    assert.equal(code, 0, JSON.stringify(result));
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
    assert.match(uninstallString, /^"[^"]*\\System32\\conhost\.exe" --headless "[^"]*powershell\.exe" -NoProfile -STA -ExecutionPolicy Bypass -File "[^"]+\.ps1" -InstallDir "[^"]+"$/);
    assert.ok(uninstallString.toLowerCase().endsWith(`-installdir "${box.canonical.toLowerCase()}"`), "for THIS install");
    const copy = uninstallerCopy(e);
    assert.ok(copy.toLowerCase().startsWith(join(box.appData, "uninstallers").toLowerCase()), "the copy lives in %LOCALAPPDATA%\\Granted, not in the install");
    assert.equal(readFileSync(copy, "utf8"), readFileSync(scriptIn(box, "uninstall.ps1"), "utf8"));
    assert.equal(e["QuietUninstallString"], `${uninstallString} -Quiet`);
  });

  test("-Register again refreshes the same entry rather than adding a second", async () => {
    const box = makeBox();
    await uninstall(box, ["-Register"]);
    await uninstall(box, ["-Register"]);
    assert.equal((await entries()).filter((e) => String(e["InstallLocation"]).toLowerCase() === box.canonical.toLowerCase()).length, 1);
  });

  test("-Register refuses a folder that isn't a Granted install, and writes nothing", async () => {
    const box = makeBox({ packageName: "something-else" });
    const { code, result } = await uninstall(box, ["-Register"]);
    assert.equal(code, 1);
    assert.equal(result["reason"], "error");
    assert.equal(await entryFor(box), undefined);
  });

  test("REGRESSION (review): a clone the installer didn't make (someone's own checkout) is never listed — unless -Force", async () => {
    const box = makeBox({ marker: false });
    const { code, result } = await uninstall(box, ["-Register"]);
    assert.equal(code, 0);
    assert.equal(result["registered"], false);
    assert.equal(result["reason"], "not-made-by-installer");
    assert.equal(await entryFor(box), undefined);
    assert.equal((await uninstall(box, ["-Register", "-Force"])).result["registered"], true);
    assert.ok(await entryFor(box));
  });

  test("REGRESSION (CI): registered through the 8.3 short form, uninstalled through the long one — the same entry, removed", async () => {
    const box = makeBox({ name: "granted-long-folder-name-for-8dot3" });
    const short = (await ps(`(New-Object -ComObject Scripting.FileSystemObject).GetFolder(${psq(box.canonical)}).ShortPath`)).trim();
    if (short.toLowerCase() === box.canonical.toLowerCase()) return; // 8.3 names are off on this volume: nothing to test
    await uninstall(box, ["-Register", "-InstallDir", short]);
    assert.ok(await entryFor(box), "recorded under the long form");
    const { code } = await uninstall(box, ["-Quiet", "-InstallDir", box.canonical]);
    assert.equal(code, 0);
    assert.equal(await entryFor(box), undefined);
  });

  test("-Quiet uninstall: quits the running tray and server, removes this install's shortcuts, the folder (long paths, read-only files), the entry and app data — keeping a copy of the keys and settings when asked", async () => {
    const box = makeBox();
    await uninstall(box, ["-Register"]);
    await execFileAsync("powershell.exe", [...PS, scriptIn(box, "shortcuts.ps1"), "-Desktop", "-StartMenu", "-DesktopDir", box.desktop, "-StartMenuDir", box.startMenu], { windowsHide: true });
    const port = nextPort++;
    const tray = spawn("powershell.exe", [...PS, scriptIn(box, "granted-tray.ps1"), "-NoTray", "-Port", String(port)], { windowsHide: true, stdio: "ignore", env: box.env });
    started.push(tray);
    assert.equal(await until(() => probeGranted(`http://127.0.0.1:${port}/`, 2000), (p) => p === "granted"), "granted");
    await onlyEntry(box);

    const backup = join(root, `kept-${seq++}`);
    const { code, result } = await uninstall(box, ["-Quiet", "-KeepKeys", "-BackupDir", backup]);
    assert.equal(code, 0, JSON.stringify(result));
    assert.equal(result["removed"], true);
    assert.equal(existsSync(box.installDir), false, "the whole folder is gone");
    assert.equal(result["leftover"] ?? null, null, "nothing left behind");
    assert.equal(readdirSync(join(box.installDir, "..")).some((n) => n.includes(".uninstalling-")), false);
    await exited(tray);
    assert.equal(await probeGranted(`http://127.0.0.1:${port}/`, 1000), "down", "the server went with the tray");
    assert.equal(existsSync(join(box.desktop, "Granted.lnk")), false);
    assert.equal(existsSync(join(box.startMenu, "Granted.lnk")), false);
    assert.equal(await entryFor(box), undefined, "the Installed apps entry is gone");
    // REGRESSION (review): every key, wherever it was -- not just three names.
    assert.equal(result["keptKeys"], backup);
    const env = readFileSync(join(backup, ".env.local"), "utf8");
    assert.match(env, /^OPENAI_API_KEY=sk-uninstall-test-0000000000$/m);
    assert.match(env, /^LLM_API_KEY=sk-only-here-0000000000$/m);
    assert.match(readFileSync(join(backup, "llm-config.json"), "utf8"), /sk-in-settings/);
    assert.equal(existsSync(box.appData), false, "the last install out takes the settings, logs and uninstaller copies with it");
  });

  test("another install's shortcut, settings and uninstaller stay while another Granted is still registered", async () => {
    const other = makeBox({ name: "granted-other" });
    const box = makeBox({ sharedWith: other });
    await uninstall(box, ["-Register"]);
    await uninstall(other, ["-Register"]);
    // The other install's shortcut sits where this one's would.
    await execFileAsync("powershell.exe", [...PS, scriptIn(other, "shortcuts.ps1"), "-Desktop", "-DesktopDir", box.desktop], { windowsHide: true });
    const { code } = await uninstall(box, ["-Quiet"]);
    assert.equal(code, 0);
    assert.equal(existsSync(box.installDir), false);
    assert.equal(existsSync(join(box.desktop, "Granted.lnk")), true, "not this install's shortcut: left alone");
    assert.equal(existsSync(join(box.appData, "settings.json")), true, "another Granted is still installed: settings stay");
    const otherEntry = await entryFor(other);
    assert.ok(otherEntry, "and its entry stays");
    assert.equal(existsSync(uninstallerCopy(otherEntry)), true, "and its uninstaller");
  });

  test("REGRESSION (review): node running from a SIBLING folder (granted-test-install-dev) isn't stopped", async () => {
    const box = makeBox();
    const sibling = `${box.installDir}-dev`;
    mkdirSync(sibling, { recursive: true });
    writeFileSync(join(sibling, "server.js"), "setInterval(() => {}, 1000);");
    const node = spawn(process.execPath, [join(sibling, "server.js")], { windowsHide: true, stdio: "ignore" });
    started.push(node);
    await sleep(500);
    try {
      assert.equal((await uninstall(box, ["-Quiet"])).code, 0);
      assert.equal(node.exitCode, null, "still running");
    } finally {
      node.kill();
    }
  });

  test("without -KeepKeys, -Quiet keeps no copy of the keys", async () => {
    const box = makeBox();
    const backup = join(root, `should-not-exist-${seq++}`);
    const { code, result } = await uninstall(box, ["-Quiet", "-BackupDir", backup]);
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

  test("REGRESSION (review): a folder with work that isn't on GitHub is refused by -Quiet (exit 4), and only -Force deletes it", async () => {
    const box = makeBox();
    // A real git repo this time, committed clean, then edited.
    await rm(join(box.installDir, ".git"), { recursive: true, force: true });
    writeFileSync(join(box.installDir, ".gitignore"), "node_modules/\n.env.local\ndata/\n");
    git(box.installDir, "init", "-q");
    git(box.installDir, "add", "-A");
    git(box.installDir, "commit", "-q", "-m", "clean");
    writeFileSync(join(box.installDir, ".git", "granted-installer"), "test");
    writeFileSync(join(box.scaffold, "fake-dev.js"), "// my local change\n");
    const { code, result } = await uninstall(box, ["-Quiet"]);
    assert.equal(code, 4);
    assert.equal(result["reason"], "unsaved-work");
    assert.match(JSON.stringify(result["unsaved"]), /changed or new files/);
    assert.match(JSON.stringify(result["unsaved"]), /commits that aren't pushed/, "a local-only commit counts too (no remote here)");
    assert.equal(existsSync(join(box.scaffold, "fake-dev.js")), true, "nothing deleted");
    assert.equal((await uninstall(box, ["-Quiet", "-Force"])).code, 0);
    assert.equal(existsSync(box.installDir), false);
  });

  test("REGRESSION (review): on a release install (a tag, no branch: detached HEAD) a commit counts as unsaved work; the tag itself doesn't", async () => {
    /** A box whose folder is a real git repo checked out the way a release install is: on tag v0.1.0, no branch. */
    function releaseBox(): Box {
      const box = makeBox();
      execFileSync("cmd.exe", ["/d", "/c", "rd", "/s", "/q", join(box.installDir, ".git")], { windowsHide: true });
      writeFileSync(join(box.installDir, ".gitignore"), "node_modules/\n.env.local\ndata/\n");
      git(box.installDir, "init", "-q", "-b", "main");
      git(box.installDir, "add", "-A");
      git(box.installDir, "commit", "-q", "-m", "release");
      git(box.installDir, "tag", "v0.1.0");
      git(box.installDir, "checkout", "-q", "--detach", "v0.1.0");
      git(box.installDir, "branch", "-q", "-D", "main");
      writeFileSync(join(box.installDir, ".git", "granted-installer"), "test");
      return box;
    }
    const clean = releaseBox();
    assert.equal((await uninstall(clean, ["-Quiet"])).code, 0, "just the release: nothing to lose");

    const edited = releaseBox();
    writeFileSync(join(edited.scaffold, "fake-dev.js"), "// my change\n");
    git(edited.installDir, "commit", "-q", "-am", "my change, on no branch");
    const { code, result } = await uninstall(edited, ["-Quiet"]);
    assert.equal(code, 4, JSON.stringify(result));
    assert.match(JSON.stringify(result["unsaved"]), /commits that aren't pushed \(1\)/);
    assert.equal(existsSync(join(edited.scaffold, "fake-dev.js")), true);
  });

  test("REGRESSION (review): a folder deleted by hand can still be removed from Installed apps — its uninstaller lives outside it", async () => {
    const box = makeBox();
    await uninstall(box, ["-Register"]);
    await onlyEntry(box);
    const copy = uninstallerCopy((await entryFor(box))!);
    await rm(box.installDir, { recursive: true, force: true });
    const { code, result } = await uninstall(box, ["-Quiet", "-InstallDir", box.canonical], copy);
    assert.equal(code, 0, JSON.stringify(result));
    assert.equal(result["alreadyGone"], true);
    assert.equal(await entryFor(box), undefined);
    assert.equal(existsSync(box.appData), false, "it was the last install: app data (and the copy) go too");
  });

  test("REGRESSION (review): files still in use -> exit 3, and NOTHING changed: folder, shortcuts and entry all kept, so it can be retried", async () => {
    const box = makeBox();
    await uninstall(box, ["-Register"]);
    await execFileAsync("powershell.exe", [...PS, scriptIn(box, "shortcuts.ps1"), "-Desktop", "-DesktopDir", box.desktop], { windowsHide: true });
    // Something that isn't Granted's (so it isn't stopped) holding a folder inside
    // as its working directory. (ping itself, not via cmd: killing a cmd would
    // orphan its ping, still holding the folder.)
    const holder = spawn("ping.exe", ["-n", "120", "127.0.0.1"], { cwd: join(box.scaffold, "scripts"), windowsHide: true, stdio: "ignore" });
    started.push(holder);
    await sleep(500);
    try {
      const { code, result } = await uninstall(box, ["-Quiet"]);
      assert.equal(code, 3);
      assert.equal(result["reason"], "files-in-use");
      assert.ok(await entryFor(box), "the entry stays for a retry");
      assert.equal(existsSync(join(box.scaffold, "package.json")), true, "nothing was deleted: still a whole, retryable install");
      assert.equal(existsSync(join(box.desktop, "Granted.lnk")), true, "and the shortcut is still there");
    } finally {
      holder.kill();
      await exited(holder);
    }
    const retry = await uninstall(box, ["-Quiet"]);
    assert.equal(retry.code, 0, "once nothing holds it, uninstalling again works");
    assert.equal(existsSync(box.installDir), false);
    assert.equal(existsSync(join(box.desktop, "Granted.lnk")), false);
    assert.equal(await entryFor(box), undefined);
  });

  test("REGRESSION (review): an install folder that's a junction is refused, never reported as removed", async () => {
    const real = makeBox({ name: "granted-real-target" });
    const link = join(root, `junction-${seq++}`);
    execFileSync("cmd.exe", ["/d", "/c", "mklink", "/J", link, real.installDir], { windowsHide: true, stdio: "ignore" });
    const { code, result } = await uninstall(real, ["-Quiet", "-InstallDir", link]);
    assert.equal(code, 2);
    assert.equal(result["reason"], "is-a-link");
    assert.equal(existsSync(join(real.scaffold, ".env.local")), true, "the real files are untouched");
  });

  test("REGRESSION (review): brackets in the path — register and uninstall both work, using the script's own location", async () => {
    const box = makeBox({ parent: `[x] box-${seq++}` });
    const reg = await uninstall(box, ["-Register"]);
    assert.equal(reg.code, 0, JSON.stringify(reg.result));
    assert.ok(await entryFor(box));
    const { code, result } = await uninstall(box, ["-Quiet"]);
    assert.equal(code, 0, JSON.stringify(result));
    assert.equal(existsSync(box.installDir), false);
  });

  test("REGRESSION (review): an unexpected error is reported (exit 1, a JSON reason) rather than failing silently", async () => {
    const box = makeBox();
    const { code, result } = await uninstall(box, ["-Quiet", "-KeepKeys", "-BackupDir", "Q:\\no-such-drive\\backup"]);
    assert.equal(code, 1);
    assert.equal(result["reason"], "error");
    assert.ok(String(result["detail"]).length > 0);
    assert.equal(existsSync(join(box.scaffold, "package.json")), true, "it stopped before deleting anything");
  });
});
