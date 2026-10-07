import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchLatestRelease, isNewerRelease, parseLatestRelease, parseReleaseTag, versionToTag } from "../releases";
import {
  appVersion,
  installInfo,
  parseUninstallCheck,
  parseUninstallOutcome,
  readUninstallCheck,
  readUninstallOutcome,
  readUpdateSettings,
  readUpdateStatus,
  settingsPath,
  startProcessCommand,
  startUninstaller,
  startUpdater,
  uninstallArgs,
  uninstallCheckArgs,
  uninstallInfo,
  uninstallLogPath,
  updateLogPath,
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
    assert.deepEqual(installInfo(scaffold, "win32", has(marker, updater)), {
      installDir: "C:\\x\\granted",
      canUpdate: true,
      reason: null,
      script: "C:\\x\\granted\\scaffold\\scripts\\windows\\update.ps1",
    });
    assert.equal(installInfo(scaffold, "win32", has(updater)).reason, "not-installer-made", "a developer's own checkout");
    assert.equal(installInfo(scaffold, "win32", has(marker)).reason, "no-updater");
    // Nothing a copy that can't update itself could be run with.
    assert.equal(installInfo(scaffold, "win32", has(marker)).script, null);
    // The Windows path is win32 on every runner (see the note below).
    assert.ok(!installInfo(scaffold, "win32", has(marker, updater)).script?.includes("/"));
  });

  // The same question on macOS, which has its own updater since the installer
  // came to it: scripts/macos/update.sh, gated on the very same marker.
  test("an installer-made macOS install with scripts/macos/update.sh can update itself too", () => {
    const scaffold = "/Users/a/granted/scaffold";
    const has = (...paths: string[]) => (p: string) => paths.some((q) => p.endsWith(q));
    const marker = "/.git/granted-installer";
    const updater = "/scripts/macos/update.sh";
    assert.deepEqual(installInfo(scaffold, "darwin", has(marker, updater)), {
      installDir: "/Users/a/granted",
      canUpdate: true,
      reason: null,
      script: "/Users/a/granted/scaffold/scripts/macos/update.sh",
    });
    // BOTH halves are required, each with its own reason.
    assert.equal(installInfo(scaffold, "darwin", has(updater)).reason, "not-installer-made", "a developer's own checkout");
    assert.equal(installInfo(scaffold, "darwin", has(marker)).reason, "no-updater", "an install made before update.sh existed");
    assert.equal(installInfo(scaffold, "darwin", () => false).reason, "not-installer-made");
    for (const missing of [has(updater), has(marker), () => false] as Array<(p: string) => boolean>) {
      assert.equal(installInfo(scaffold, "darwin", missing).script, null);
      assert.equal(installInfo(scaffold, "darwin", missing).canUpdate, false);
    }
    // A platform with no updater of its own is refused before either is asked
    // about — the marker and the script are both there in this call.
    assert.equal(installInfo(scaffold, "linux", has(marker, updater)).reason, "unsupported-platform");
    assert.equal(installInfo(scaffold, "linux", has(marker, updater)).script, null);
    // The macOS path is POSIX on every runner (see the note below).
    assert.ok(!installInfo(scaffold, "darwin", has(marker, updater)).script?.includes("\\"));
  });

  // The macOS updater looks at the SAME marker the macOS uninstaller does, and
  // each gates on its own script: an install with one but not the other can do
  // exactly the one it has.
  test("the marker is shared; each script gates only its own feature", () => {
    const scaffold = "/Users/a/granted/scaffold";
    const has = (...paths: string[]) => (p: string) => paths.some((q) => p.endsWith(q));
    const marker = "/.git/granted-installer";
    const onlyUpdate = has(marker, "/scripts/macos/update.sh");
    const onlyUninstall = has(marker, "/scripts/macos/uninstall.sh");
    assert.equal(installInfo(scaffold, "darwin", onlyUpdate).canUpdate, true);
    assert.equal(uninstallInfo(scaffold, "darwin", onlyUpdate).reason, "no-uninstaller");
    assert.equal(uninstallInfo(scaffold, "darwin", onlyUninstall).canUninstall, true);
    assert.equal(installInfo(scaffold, "darwin", onlyUninstall).reason, "no-updater");
  });

  // The uninstall half of the same question, and macOS-only on purpose: a
  // Windows install is uninstalled from Windows' own "Installed apps" list.
  test("only an installer-made macOS install with the uninstaller can uninstall itself", () => {
    const scaffold = "/Users/a/granted/scaffold";
    const has = (...paths: string[]) => (p: string) => paths.some((q) => p.endsWith(q));
    const marker = "/.git/granted-installer";
    const script = "/scripts/macos/uninstall.sh";
    const both = uninstallInfo(scaffold, "darwin", has(marker, script));
    assert.deepEqual(both, {
      installDir: "/Users/a/granted",
      canUninstall: true,
      reason: null,
      script: "/Users/a/granted/scaffold/scripts/macos/uninstall.sh",
    });
    assert.equal(uninstallInfo(scaffold, "win32", has(marker, script)).reason, "not-macos");
    assert.equal(uninstallInfo(scaffold, "linux", has(marker, script)).reason, "not-macos");
    assert.equal(uninstallInfo(scaffold, "darwin", has(script)).reason, "not-installer-made", "a developer's own checkout");
    assert.equal(uninstallInfo(scaffold, "darwin", has(marker)).reason, "no-uninstaller");
    // Nothing a copy that can't uninstall itself could be run with.
    for (const platform of ["win32", "linux"] as const) {
      assert.equal(uninstallInfo(scaffold, platform, has(marker, script)).script, null);
    }
    // The macOS path is POSIX on every runner (see the note below).
    assert.ok(!both.script?.includes("\\"));
  });
});

// Every expected path below is written out as a literal string, never rebuilt
// with the ambient `join`. Rebuilding it makes the assertion tautological: the
// test picks up the very same platform-dependent separator the code under test
// did, so a branch that joins a macOS path with Windows separators (or the
// reverse) still "passes" on every runner. That exact bug in the installer's
// own grantedSettingsPath only surfaced on the windows-latest CI runner, where
// its test did assert a literal.
describe("settings and status (the file the tray and installer share)", () => {
  test("lives in %LOCALAPPDATA%\\Granted unless a test overrides it", () => {
    assert.equal(settingsPath({ LOCALAPPDATA: "C:\\L" }), "C:\\L\\Granted\\settings.json");
    assert.equal(settingsPath({ GRANTED_SETTINGS_PATH: "C:\\t\\s.json", LOCALAPPDATA: "C:\\L" }), "C:\\t\\s.json");
    assert.equal(updateStatusPath({ GRANTED_SETTINGS_PATH: join("C:\\t", "s.json") }), join("C:\\t", "update-status.json"));
  });

  // macOS's own per-user location, shared with scripts/macos/granted-tray.sh
  // and the Swift menu-bar helper (which read and write the same openIn /
  // autoUpdate / lastAutoCheck keys Windows uses) — not ~/.granted, which is
  // what every non-Windows platform used before background running on macOS.
  test("macOS: ~/Library/Application Support/Granted/settings.json; elsewhere ~/.granted", () => {
    assert.equal(settingsPath({}, "darwin", "/Users/a"), "/Users/a/Library/Application Support/Granted/settings.json");
    assert.equal(settingsPath({}, "linux", "/home/a"), "/home/a/.granted/settings.json");
    // The overrides still win on macOS, in the same order.
    assert.equal(settingsPath({ GRANTED_SETTINGS_PATH: "/t/s.json" }, "darwin", "/Users/a"), "/t/s.json");
    assert.equal(settingsPath({ LOCALAPPDATA: "C:\\L" }, "darwin", "/Users/a"), "C:\\L\\Granted\\settings.json");
    // Nothing above may depend on the OS this test runs under: the macOS path
    // must never gain a backslash, and the Windows one never a forward slash.
    assert.ok(!settingsPath({}, "darwin", "/Users/a").includes("\\"), "the macOS path is POSIX on every runner");
    assert.ok(!settingsPath({ LOCALAPPDATA: "C:\\L" }).includes("/"), "the Windows path is win32 on every runner");
    // update-status.json follows the settings file, so it lands there too.
    assert.equal(
      updateStatusPath({ GRANTED_SETTINGS_PATH: join("/Users/a/Library/Application Support/Granted", "settings.json") }),
      join("/Users/a/Library/Application Support/Granted", "update-status.json"),
    );
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

  test("Windows: runs update.ps1 for the release and port, hidden (conhost --headless), out of this server's tree", async () => {
    const calls: Array<{ file: string; args: string[]; options: Record<string, unknown> }> = [];
    const spawnImpl = ((file: string, args: string[], options: Record<string, unknown>) => {
      calls.push({ file, args, options });
      return { once(event: string, cb: (code: number) => void) { if (event === "exit") setTimeout(() => cb(0), 0); } };
    }) as unknown as typeof import("node:child_process").spawn;
    await startUpdater("v0.2.0", 3123, { dir: "C:\\g\\scaffold", platform: "win32", systemRoot: "C:\\Windows", spawnImpl });
    assert.equal(calls.length, 1);
    const { file, args, options } = calls[0];
    assert.match(file, /powershell\.exe$/i);
    const command = args[args.indexOf("-Command") + 1];
    assert.match(command, /^Start-Process -FilePath 'C:\\Windows\\System32\\conhost\.exe' -ArgumentList '--headless /);
    assert.match(command, /-File C:\\g\\scaffold\\scripts\\windows\\update\.ps1 -Ref v0\.2\.0 -Port 3123'$/);
    assert.equal(options["detached"], undefined, "REGRESSION (review): detached gives PowerShell no console, and it never runs the update");
    assert.equal(options["stdio"], "ignore");
    assert.equal(options["windowsHide"], true);
  });

  // macOS has no Start-Process: the updater is started exactly the way the
  // uninstaller is, because it has exactly the same problem — it stops this
  // very server partway through.
  test("macOS: runs update.sh detached, out of the install folder, with its output in a file", async () => {
    const calls: Array<{ file: string; args: string[]; options: Record<string, unknown> }> = [];
    const closed: number[] = [];
    const spawnImpl = ((file: string, args: string[], options: Record<string, unknown>) => {
      calls.push({ file, args, options });
      return {
        unref() {},
        once(event: string, cb: () => void) {
          if (event === "spawn") setTimeout(cb, 0);
        },
      };
    }) as unknown as typeof import("node:child_process").spawn;
    await startUpdater("v0.2.0", 3123, {
      dir: "/Users/a/granted/scaffold",
      platform: "darwin",
      spawnImpl,
      logPath: "/tmp/up.log",
      openImpl: (() => 9) as unknown as typeof import("node:fs").openSync,
      closeImpl: (fd: number) => closed.push(fd),
    });
    assert.equal(calls.length, 1);
    const { file, args, options } = calls[0];
    assert.equal(file, "/bin/bash");
    assert.deepEqual(args, ["/Users/a/granted/scaffold/scripts/macos/update.sh", "--ref", "v0.2.0", "--port", "3123"]);
    // The three things that keep the updater alive while it stops the very
    // server that started it: its own session, a working directory outside the
    // install being replaced, and no pipe back to this process.
    assert.equal(options["detached"], true);
    assert.equal(options["cwd"], "/");
    assert.deepEqual(options["stdio"], ["ignore", 9, 9]);
    assert.deepEqual(closed, [9], "this process doesn't keep the log's descriptor");
    // The macOS path is POSIX on every runner, Windows CI included.
    assert.ok(!args[0].includes("\\"));
  });

  test("macOS: an updater that can't be started is reported, not swallowed", async () => {
    const spawnImpl = (() => ({
      unref() {},
      once(event: string, cb: (err?: Error) => void) {
        if (event === "error") setTimeout(() => cb(new Error("ENOENT")), 0);
      },
    })) as unknown as typeof import("node:child_process").spawn;
    await assert.rejects(
      () => startUpdater("v0.2.0", 3000, { dir: "/nope/scaffold", platform: "darwin", spawnImpl, logPath: join(dir, "up.log") }),
      /ENOENT/,
    );
  });

  test("the updater's own log goes in the temporary folder, next to the uninstaller's", () => {
    assert.equal(updateLogPath(new Date("2026-10-06T12:34:56.000Z"), "/tmp"), "/tmp/granted-update-2026-10-06T12-34-56-000Z.log");
  });
});

describe("starting the uninstaller (macOS)", () => {
  test("--quiet always, --keep-keys unless turned off, --force only when asked for", () => {
    const script = "/g/scaffold/scripts/macos/uninstall.sh";
    assert.deepEqual(uninstallArgs(script, { keepKeys: true, force: false }), [script, "--quiet", "--keep-keys"]);
    assert.deepEqual(uninstallArgs(script, { keepKeys: false, force: false }), [script, "--quiet", "--no-keep-keys"]);
    assert.deepEqual(uninstallArgs(script, { keepKeys: true, force: true }), [script, "--quiet", "--keep-keys", "--force"]);
    assert.deepEqual(uninstallCheckArgs(script), [script, "--check"]);
  });

  test("parseUninstallCheck reads the script's own line, and nothing it doesn't recognize", () => {
    const line =
      '{"check":true,"installDir":"/g","exists":true,"isLink":false,"grantedInstall":true,"installerMade":true,' +
      '"unsaved":["changed or new files (2)"],"keyFiles":["/g/scaffold/.env.local"],"launchAgent":"own","launcher":"none",' +
      '"settingsPath":"/s","logDir":"/l","backupDir":"/b"}';
    assert.deepEqual(parseUninstallCheck(`something a shell printed\n${line}\n`), {
      installDir: "/g",
      grantedInstall: true,
      installerMade: true,
      unsaved: ["changed or new files (2)"],
      keyFiles: ["/g/scaffold/.env.local"],
      backupDir: "/b",
    });
    // An uninstall's own result line is not a check, and must never be read as one.
    assert.equal(parseUninstallCheck('{"removed":true,"installDir":"/g"}'), null);
    assert.equal(parseUninstallCheck("not json at all"), null);
    assert.equal(parseUninstallCheck(""), null);
    // A garbled list is a list of nothing, never a crash.
    assert.deepEqual(parseUninstallCheck('{"check":true,"unsaved":"lots"}')?.unsaved, []);
  });

  test("readUninstallCheck runs uninstall.sh --check through bash, and reads nothing as nothing", async () => {
    const calls: Array<{ file: string; args: string[] }> = [];
    const execFileImpl = ((file: string, args: string[], _options: unknown, cb: (e: null, out: string) => void) => {
      calls.push({ file, args });
      cb(null, '{"check":true,"installDir":"/g","grantedInstall":true,"installerMade":true,"unsaved":[],"keyFiles":[],"backupDir":"/b"}');
    }) as unknown as typeof import("node:child_process").execFile;
    const check = await readUninstallCheck("/g/scaffold/scripts/macos/uninstall.sh", { execFileImpl });
    assert.deepEqual(calls, [{ file: "/bin/bash", args: ["/g/scaffold/scripts/macos/uninstall.sh", "--check"] }]);
    assert.equal(check?.installerMade, true);

    const broken = ((_f: string, _a: string[], _o: unknown, cb: (e: Error, out: string) => void) => {
      cb(new Error("no such file"), "");
    }) as unknown as typeof import("node:child_process").execFile;
    assert.equal(await readUninstallCheck("/nope", { execFileImpl: broken }), null);
  });

  test("the uninstaller is started detached, out of the folder it deletes, with its output in a file", async () => {
    const calls: Array<{ file: string; args: string[]; options: Record<string, unknown> }> = [];
    const closed: number[] = [];
    const spawnImpl = ((file: string, args: string[], options: Record<string, unknown>) => {
      calls.push({ file, args, options });
      return {
        unref() {},
        once(event: string, cb: () => void) {
          if (event === "spawn") setTimeout(cb, 0);
        },
      };
    }) as unknown as typeof import("node:child_process").spawn;
    const log = await startUninstaller(
      "/g/scaffold/scripts/macos/uninstall.sh",
      { keepKeys: true, force: false },
      { spawnImpl, logPath: "/tmp/u.log", openImpl: (() => 7) as unknown as typeof import("node:fs").openSync, closeImpl: (fd: number) => closed.push(fd) },
    );
    assert.equal(log, "/tmp/u.log");
    assert.equal(calls.length, 1);
    const { file, args, options } = calls[0];
    assert.equal(file, "/bin/bash");
    assert.deepEqual(args, ["/g/scaffold/scripts/macos/uninstall.sh", "--quiet", "--keep-keys"]);
    // The three things that keep the uninstaller alive while it stops the very
    // server that started it: its own session, a working directory outside the
    // folder being deleted, and no pipe back to this process.
    assert.equal(options["detached"], true);
    assert.equal(options["cwd"], "/");
    assert.deepEqual(options["stdio"], ["ignore", 7, 7]);
    assert.deepEqual(closed, [7], "this process doesn't keep the log's descriptor");
  });

  test("an uninstaller that can't be started is reported, not swallowed", async () => {
    const spawnImpl = (() => ({
      unref() {},
      once(event: string, cb: (err?: Error) => void) {
        if (event === "error") setTimeout(() => cb(new Error("ENOENT")), 0);
      },
    })) as unknown as typeof import("node:child_process").spawn;
    await assert.rejects(
      () => startUninstaller("/nope", { keepKeys: false, force: false }, { spawnImpl, logPath: join(dir, "u.log") }),
      /ENOENT/,
    );
  });

  test("the log goes in the temporary folder, never one the uninstall deletes", () => {
    assert.equal(uninstallLogPath(new Date("2026-10-06T12:34:56.000Z"), "/tmp"), "/tmp/granted-uninstall-2026-10-06T12-34-56-000Z.log");
  });

  // That log is the only way the server can learn what a started uninstaller
  // decided: it is answered "started" when the script has merely been spawned,
  // and the script can still refuse afterwards with everything left in place.
  test("parseUninstallOutcome reads the uninstaller's own result line, refusals included", () => {
    assert.deepEqual(
      parseUninstallOutcome(
        'fake dev server noise\n{"removed":false,"reason":"access-denied","detail":"mv: rename /g: Permission denied","installDir":"/g","keptKeys":"/b"}\n',
      ),
      { removed: false, reason: "access-denied", detail: "mv: rename /g: Permission denied", keptKeys: "/b", leftover: null },
    );
    assert.deepEqual(parseUninstallOutcome('{"removed":true,"installDir":"/g","keptKeys":null,"leftover":null}'), {
      removed: true,
      reason: null,
      detail: null,
      keptKeys: null,
      leftover: null,
    });
    // Nothing readable is "it hasn't said yet", never a guess either way.
    assert.equal(parseUninstallOutcome(""), null);
    assert.equal(parseUninstallOutcome("mv: rename: Permission denied\n"), null);
    // A --check line is not an outcome, and must never be read as one.
    assert.equal(parseUninstallOutcome('{"check":true,"installDir":"/g"}'), null);
  });

  test("readUninstallOutcome reads that log from disk, and a log that isn't there yet is nothing", () => {
    const log = join(dir, "uninstall-outcome.log");
    assert.equal(readUninstallOutcome(log), null, "no log yet");
    writeFileSync(log, '{"removed":false,"reason":"files-in-use","detail":"busy","installDir":"/g"}\n', "utf8");
    assert.equal(readUninstallOutcome(log)?.reason, "files-in-use");
  });
});
