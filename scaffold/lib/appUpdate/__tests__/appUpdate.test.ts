import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchLatestRelease, isNewerRelease, parseLatestRelease, parseReleaseTag, versionToTag } from "../releases";
import {
  appVersion,
  installInfo,
  readUpdateSettings,
  readUpdateStatus,
  settingsPath,
  startProcessCommand,
  startUpdater,
  updateStatusPath,
  writeUpdateSettings,
} from "../install";

const dir = mkdtempSync(join(tmpdir(), "granted-appupdate-"));
after(() => rmSync(dir, { recursive: true, force: true }));

describe("releases", () => {
  test("only vMAJOR.MINOR.PATCH is a release; package versions map to tags", () => {
    assert.deepEqual(parseReleaseTag("v0.10.2"), [0, 10, 2]);
    assert.equal(parseReleaseTag("hackathon-deadline"), null);
    assert.equal(parseReleaseTag("v1.2.3-beta"), null);
    assert.equal(versionToTag("0.1.1"), "v0.1.1");
    assert.equal(versionToTag("0.3.0-dev"), null);
  });

  test("newer is numeric, never a downgrade", () => {
    assert.equal(isNewerRelease("v0.10.0", "v0.9.0"), true);
    assert.equal(isNewerRelease("v0.1.1", "v0.1.1"), false);
    assert.equal(isNewerRelease("v0.1.0", "v0.1.1"), false);
    assert.equal(isNewerRelease("v0.2.0", null), false, "a development version (no tag) is never offered an 'update'");
  });

  test("only a published, stable release is offered", () => {
    assert.equal(parseLatestRelease({ tag_name: "v0.2.0" }), "v0.2.0");
    assert.equal(parseLatestRelease({ tag_name: "v0.2.0", prerelease: true }), null);
    assert.equal(parseLatestRelease({ tag_name: "v0.2.0", draft: true }), null);
    assert.equal(parseLatestRelease({ tag_name: "hackathon-deadline" }), null);
  });

  test("fetchLatestRelease: tag, no releases (404) isn't a failure, errors are", async () => {
    const reply = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
    assert.deepEqual(await fetchLatestRelease("x", 1000, reply(200, { tag_name: "v1.0.0" })), { tag: "v1.0.0", failed: false });
    assert.deepEqual(await fetchLatestRelease("x", 1000, reply(404, {})), { tag: null, failed: false });
    assert.deepEqual(await fetchLatestRelease("x", 1000, reply(403, {})), { tag: null, failed: true });
    const throws = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    assert.deepEqual(await fetchLatestRelease("x", 1000, throws), { tag: null, failed: true });
  });
});

describe("this install", () => {
  test("appVersion reads scaffold/package.json", () => {
    const d = join(dir, "pkg");
    rmSync(d, { recursive: true, force: true });
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "package.json"), JSON.stringify({ name: "granted", version: "0.4.2" }));
    assert.equal(appVersion(d), "0.4.2");
    assert.equal(appVersion(join(dir, "nowhere")), "0.0.0");
  });

  test("only an installer-made Windows install with the updater can update itself", () => {
    const scaffold = "C:\\x\\granted\\scaffold";
    const has = (...paths: string[]) => (p: string) => paths.some((q) => p.toLowerCase().endsWith(q));
    const marker = "\\.git\\granted-installer";
    const updater = "\\scripts\\windows\\update.ps1";
    assert.deepEqual(installInfo(scaffold, "win32", has(marker, updater)).reason, null);
    assert.equal(installInfo(scaffold, "win32", has(marker, updater)).canUpdate, true);
    assert.equal(installInfo(scaffold, "darwin", has(marker, updater)).reason, "not-windows");
    assert.equal(installInfo(scaffold, "win32", has(updater)).reason, "not-installer-made", "a developer's own checkout");
    assert.equal(installInfo(scaffold, "win32", has(marker)).reason, "no-updater");
  });
});

describe("settings and status (the file the tray and installer share)", () => {
  test("lives in %LOCALAPPDATA%\\Granted unless a test overrides it", () => {
    assert.equal(settingsPath({ LOCALAPPDATA: "C:\\L" }), join("C:\\L", "Granted", "settings.json"));
    assert.equal(settingsPath({ GRANTED_SETTINGS_PATH: "C:\\t\\s.json", LOCALAPPDATA: "C:\\L" }), "C:\\t\\s.json");
    assert.equal(updateStatusPath({ GRANTED_SETTINGS_PATH: join("C:\\t", "s.json") }), join("C:\\t", "update-status.json"));
  });

  test("auto-update is off unless turned on; saving keeps the file's other settings (e.g. openIn)", () => {
    const p = join(dir, "s1", "settings.json");
    assert.deepEqual(readUpdateSettings(p), { autoUpdate: false, lastAutoCheck: null });
    mkdirSync(join(dir, "s1"), { recursive: true });
    writeFileSync(p, "\uFEFF" + JSON.stringify({ openIn: "browser" }));
    writeUpdateSettings({ autoUpdate: true }, p);
    writeUpdateSettings({ lastAutoCheck: 1234 }, p);
    assert.deepEqual(JSON.parse(readFileSync(p, "utf8")), { openIn: "browser", autoUpdate: true, lastAutoCheck: 1234 });
    assert.deepEqual(readUpdateSettings(p), { autoUpdate: true, lastAutoCheck: 1234 });
  });

  test("readUpdateStatus: what update.ps1 wrote (with PowerShell's BOM), or nothing", () => {
    const p = join(dir, "update-status.json");
    assert.equal(readUpdateStatus(p), null);
    writeFileSync(p, '\uFEFF{"state":"error","to":"v0.2.0","message":"boom"}');
    assert.deepEqual(readUpdateStatus(p), { state: "error", to: "v0.2.0", message: "boom" });
    writeFileSync(p, '{"state":"weird"}');
    assert.equal(readUpdateStatus(p), null);
  });
});

describe("starting the updater", () => {
  test("Start-Process with every value a single-quoted literal (no $ or quote injection)", () => {
    assert.equal(
      startProcessCommand("C:\\W\\conhost.exe", ["--headless", "C:\\Users\\O'Brien $x\\update.ps1", "-Ref", "v1.0.0"]),
      "Start-Process -FilePath 'C:\\W\\conhost.exe' -ArgumentList '--headless \"C:\\Users\\O''Brien $x\\update.ps1\" -Ref v1.0.0'",
    );
  });

  test("runs update.ps1 for the release and port, hidden (conhost --headless), detached from this server", () => {
    const calls: Array<{ file: string; args: string[]; options: Record<string, unknown> }> = [];
    const spawnImpl = ((file: string, args: string[], options: Record<string, unknown>) => {
      calls.push({ file, args, options });
      return { on() {}, unref() {} };
    }) as unknown as typeof import("node:child_process").spawn;
    startUpdater("v0.2.0", 3123, { dir: "C:\\g\\scaffold", systemRoot: "C:\\Windows", spawnImpl });
    assert.equal(calls.length, 1);
    const { file, args, options } = calls[0];
    assert.match(file, /powershell\.exe$/i);
    const command = args[args.indexOf("-Command") + 1];
    assert.match(command, /^Start-Process -FilePath 'C:\\Windows\\System32\\conhost\.exe' -ArgumentList '--headless /);
    assert.match(command, /-File C:\\g\\scaffold\\scripts\\windows\\update\.ps1 -Ref v0\.2\.0 -Port 3123'$/);
    assert.equal(options["detached"], true);
    assert.equal(options["stdio"], "ignore");
    assert.equal(options["windowsHide"], true);
  });
});
