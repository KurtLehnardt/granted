/**
 * Integration: the REAL scaffold/scripts/macos/applications-launcher.sh — the
 * per-user ~/Applications launcher, its icon and its Dock entry — run for
 * real against a fake Granted install. The macOS counterpart of
 * tray.integration.test.ts's shortcut coverage, and the launcher half of what
 * macTray.integration.test.ts does for the background server.
 *
 * Nothing here touches anything real. The launcher is created in a throwaway
 * folder (GRANTED_APPLICATIONS_DIR), never ~/Applications; the Dock entry is
 * written to a throwaway `defaults` domain — a plist file of its own, chosen
 * by path (GRANTED_DOCK_DOMAIN) — never com.apple.dock, and the Dock is never
 * restarted (GRANTED_DOCK_RELOAD_CMD=none). The launcher-really-starts-Granted
 * test runs against the same kind of fake install macTray.integration.test.ts
 * uses: a throwaway LaunchAgent label, a tiny Node server standing in for
 * `npm run dev`, no menu-bar icon, and a stand-in for `open`.
 *
 * The file-shape checks run anywhere; everything that runs sips, iconutil,
 * defaults, PlistBuddy or launchctl is macOS only.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { macLauncherCommand, parseLauncherOutput } from "../ipcPure";
import { probeGranted } from "../openGranted";

const execFileAsync = promisify(execFile);

// `npm test` runs from installer/; the scripts live in scaffold/.
const MACOS_SCRIPTS = resolve(process.cwd(), "..", "scaffold", "scripts", "macos");
const WINDOWS_SCRIPTS = resolve(process.cwd(), "..", "scaffold", "scripts", "windows");
const LAUNCHER_SCRIPT = join(MACOS_SCRIPTS, "applications-launcher.sh");
const TRAY_SCRIPT = join(MACOS_SCRIPTS, "granted-tray.sh");
const OPEN_SCRIPT = join(MACOS_SCRIPTS, "open-granted.sh");
const ICO = join(WINDOWS_SCRIPTS, "granted.ico");
const GRANTED_HTML = "<title>Granted — federal funding intelligence for everyone</title>";
// Not 3000, and not macTray.integration.test.ts's 3977: a real Granted (or
// that test) must never be mistaken for this one's fake server.
const PORT = 3975;
const BUNDLE_ID = "io.github.kurtlehnardt.granted.launcher";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function until<T>(fn: () => Promise<T>, ok: (v: T) => boolean, timeoutMs = 60_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last = await fn();
  while (!ok(last) && Date.now() < deadline) {
    await sleep(250);
    last = await fn();
  }
  return last;
}

interface FakeInstall {
  root: string;
  scaffold: string;
  /** The real applications-launcher.sh, where a real install has it. */
  launcherScript: string;
  /** Where the launcher bundle is created: never the real ~/Applications. */
  applicationsDir: string;
  appPath: string;
  /** The throwaway `defaults` domain standing in for the Dock. */
  dockDomain: string;
  label: string;
  /** What `open` was asked to open (the stand-in's log). */
  openedLog: string;
  env: Record<string, string>;
  cleanup: () => Promise<void>;
}

/**
 * A fake Granted install with the real macOS scripts in it, whose `npm run
 * dev` is a tiny Node server, pointed entirely at throwaway paths: its own
 * Applications folder, its own "Dock", its own LaunchAgent label, its own log
 * and settings folders, no menu-bar icon and a stand-in for `open`.
 */
async function setUpFakeInstall(): Promise<FakeInstall> {
  // realpath: mkdtemp hands back /var/folders/…, a symlink to
  // /private/var/folders/…, and the scripts resolve their own location with
  // `pwd -P` — so what the launcher bakes in is the resolved path.
  const root = realpathSync(await mkdtemp(join(tmpdir(), "granted-mac-launcher-it-")));
  const scaffold = join(root, "granted", "scaffold");
  mkdirSync(join(scaffold, "scripts", "macos"), { recursive: true });
  mkdirSync(join(scaffold, "scripts", "windows"), { recursive: true });
  mkdirSync(join(root, "LaunchAgents"), { recursive: true });
  for (const [from, to] of [
    [LAUNCHER_SCRIPT, join(scaffold, "scripts", "macos", "applications-launcher.sh")],
    [TRAY_SCRIPT, join(scaffold, "scripts", "macos", "granted-tray.sh")],
    [OPEN_SCRIPT, join(scaffold, "scripts", "macos", "open-granted.sh")],
  ] as const) {
    await writeFile(to, readFileSync(from, "utf8"), "utf8");
  }
  // The icon the launcher converts, where a real install has it.
  await writeFile(join(scaffold, "scripts", "windows", "granted.ico"), readFileSync(ICO));
  await writeFile(
    join(scaffold, "package.json"),
    JSON.stringify({ name: "fake-granted", private: true, version: "9.8.7", scripts: { dev: "node fake-dev.js" } }),
    "utf8",
  );
  await writeFile(
    join(scaffold, "fake-dev.js"),
    [
      "const port = Number(process.env.PORT);",
      'if (!port) { console.error("fake dev server: PORT not set"); process.exit(1); }',
      'require("node:http")',
      `  .createServer((_req, res) => { res.writeHead(200, { "Content-Type": "text/html" }); res.end(${JSON.stringify(GRANTED_HTML)}); })`,
      '  .listen(port, "127.0.0.1", () => console.log("fake Granted listening on 127.0.0.1:" + port));',
    ].join("\n"),
    "utf8",
  );
  // A stand-in for `open`, so nothing a test opens reaches a real browser.
  const openedLog = join(root, "opened.log");
  const openCmd = join(root, "fake-open.sh");
  await writeFile(openCmd, `#!/bin/sh\nprintf '%s\\n' "$@" >> ${JSON.stringify(openedLog)}\n`, { mode: 0o755 });
  const label = `com.granted.test.${randomUUID()}`;
  const applicationsDir = join(root, "Applications");
  const env = {
    GRANTED_APPLICATIONS_DIR: applicationsDir,
    // A path, not com.apple.dock: `defaults` then reads and writes exactly
    // this file and nothing else.
    GRANTED_DOCK_DOMAIN: join(root, "testdock"),
    // The user's real Dock must never be restarted by a test.
    GRANTED_DOCK_RELOAD_CMD: "none",
    GRANTED_LAUNCH_LABEL: label,
    GRANTED_LAUNCH_AGENTS_DIR: join(root, "LaunchAgents"),
    GRANTED_LOG_DIR: join(root, "logs"),
    GRANTED_SETTINGS_PATH: join(root, "support", "settings.json"),
    GRANTED_MENUBAR_HELPER: "none",
    GRANTED_APP_BROWSER: "none",
    GRANTED_OPEN_CMD: openCmd,
    // An osascript alert would wait for a click that never comes.
    GRANTED_LAUNCHER_ALERT: "none",
  };
  return {
    root,
    scaffold,
    launcherScript: join(scaffold, "scripts", "macos", "applications-launcher.sh"),
    applicationsDir,
    appPath: join(applicationsDir, "Granted.app"),
    dockDomain: env.GRANTED_DOCK_DOMAIN,
    label,
    openedLog,
    env,
    cleanup: async () => {
      // Whatever the test left running: stop the server and unregister the
      // throwaway label, directly as well as through the script.
      try {
        execFileSync("/bin/bash", [join(scaffold, "scripts", "macos", "granted-tray.sh"), "stop", "--port", String(PORT)], {
          stdio: "ignore",
          env: { ...process.env, ...env },
        });
      } catch {
        /* nothing was running */
      }
      try {
        execFileSync("launchctl", ["bootout", `gui/${process.getuid?.() ?? 0}/${label}`], { stdio: "ignore" });
      } catch {
        /* already gone */
      }
      await rm(root, { recursive: true, force: true, maxRetries: 5 });
    },
  };
}

// --- file-shape checks (any platform) --------------------------------------

test(
  "applications-launcher.sh never writes outside the user's own folders, and never deletes something that isn't its own bundle",
  { skip: !existsSync(LAUNCHER_SCRIPT) && "run from installer/" },
  () => {
    const script = readFileSync(LAUNCHER_SCRIPT, "utf8");
    // The code only, with the comments stripped: the header explains at
    // length what this script deliberately does NOT do, and those sentences
    // must not be mistaken for the thing itself.
    const code = script
      .split("\n")
      .filter((line) => !/^\s*#/.test(line))
      .join("\n");
    // Per-user, no admin rights: ~/Applications, never /Applications.
    assert.match(script, /GRANTED_APPLICATIONS_DIR:-\$HOME\/Applications/);
    assert.ok(!/APPLICATIONS_DIR="\/Applications"/.test(script), "never the system-wide /Applications");
    // Every destructive path is guarded by the bundle's own identifier.
    assert.match(script, /is_our_bundle/);
    assert.ok(script.includes(`BUNDLE_ID="${BUNDLE_ID}"`));
    // The Dock change goes through `defaults`, not a direct write of
    // com.apple.dock.plist (which cfprefsd can overwrite), and not AppleScript
    // UI scripting (which needs Accessibility permission).
    assert.match(code, /defaults write "\$DOCK_DOMAIN" persistent-apps -array-add/);
    assert.ok(!code.includes("Library/Preferences"), "never edits the Dock's plist file directly");
    assert.ok(!code.includes("System Events"), "no AppleScript UI scripting");
    // And the Dock restart is overridable, so a test can never restart the
    // machine's real Dock.
    assert.match(code, /GRANTED_DOCK_RELOAD_CMD-killall Dock/);
    // REGRESSION (real hardware): the restart has to be waited for. A Dock
    // that is still starting up has not read the change yet, and writes its
    // startup copy of persistent-apps back the next time it is asked to quit
    // — which silently undid a removal that followed an addition, on the real
    // Dock, a second earlier. Both operations then confirm the result by
    // reading the Dock's preferences back, not from `defaults`' exit code.
    assert.match(code, /pgrep -x Dock/, "reload_dock waits for the restarted Dock");
    assert.match(code, /dock_settles_to yes/, "an addition is confirmed by reading it back");
    assert.match(code, /dock_settles_to no/, "and so is a removal");
  },
);

test("macLauncherCommand runs the script through /bin/bash, with the port, and only asks for the Dock when told to", () => {
  assert.deepEqual(macLauncherCommand({ launcherScript: "/x/applications-launcher.sh", port: 3000, addToDock: false }), {
    file: "/bin/bash",
    args: ["/x/applications-launcher.sh", "install", "--port", "3000"],
  });
  assert.deepEqual(macLauncherCommand({ launcherScript: "/x/applications-launcher.sh", port: 3100, addToDock: true }), {
    file: "/bin/bash",
    args: ["/x/applications-launcher.sh", "install", "--port", "3100", "--add-to-dock"],
  });
});

// --- the real thing (macOS) ------------------------------------------------

describe(
  "applications-launcher.sh, run for real against a throwaway Applications folder and a throwaway Dock",
  { skip: (process.platform !== "darwin" || !existsSync(LAUNCHER_SCRIPT)) && "macOS only, run from installer/" },
  () => {
    let fake: FakeInstall;

    const launcher = (...args: string[]): Promise<{ stdout: string; stderr: string }> =>
      execFileAsync("/bin/bash", [fake.launcherScript, ...args], { env: { ...process.env, ...fake.env }, timeout: 120_000 });

    /** This fake install's throwaway Dock, as `defaults` sees it. */
    const dockPlist = (): string => {
      try {
        return execFileSync("defaults", ["export", fake.dockDomain, "-"], { encoding: "utf8" });
      } catch {
        return "";
      }
    };

    before(async () => {
      fake = await setUpFakeInstall();
    });

    after(async () => {
      await fake.cleanup();
    });

    test("install: a real .app bundle, with a valid Info.plist, an executable launcher and the icon converted from the repo's .ico", async () => {
      const { stdout } = await launcher("install", "--port", String(PORT));
      const result = parseLauncherOutput(stdout);
      assert.deepEqual(result, { launcher: fake.appPath, icon: true, dock: "skipped" });

      // The bundle's shape.
      const contents = join(fake.appPath, "Contents");
      assert.ok(existsSync(join(contents, "Info.plist")), "Contents/Info.plist");
      assert.ok(existsSync(join(contents, "MacOS", "Granted")), "Contents/MacOS/<executable>");
      assert.ok(existsSync(join(contents, "Resources", "granted.icns")), "Contents/Resources/<icon>.icns");
      assert.equal(readFileSync(join(contents, "PkgInfo"), "utf8"), "APPL????");

      // The Info.plist is a plist as far as the system is concerned, and says
      // what a launchable bundle has to say.
      await execFileAsync("/usr/bin/plutil", ["-lint", join(contents, "Info.plist")]);
      const plist = (key: string): string =>
        execFileSync("/usr/libexec/PlistBuddy", ["-c", `Print :${key}`, join(contents, "Info.plist")], { encoding: "utf8" }).trim();
      assert.equal(plist("CFBundleIdentifier"), BUNDLE_ID);
      assert.equal(plist("CFBundlePackageType"), "APPL");
      assert.equal(plist("CFBundleExecutable"), "Granted");
      assert.equal(plist("CFBundleIconFile"), "granted");
      assert.equal(plist("CFBundleName"), "Granted");
      // REGRESSION (real hardware). LSUIElement is what keeps a Dock or
      // Finder launch working at all: without it, launchd tears down the
      // app's whole job a second after this launcher exits and kills the
      // granted-tray.sh it started — so the menu-bar icon would flash and
      // vanish and Granted would never open, while the server (launchd's own
      // child) carried on, which is what made the first real double-click
      // look half-working rather than broken. Measured on this Mac: nohup, a
      // background subshell and `launchctl submit` were all killed; the same
      // bundle with this key kept its child alive.
      assert.equal(plist("LSUIElement"), "true");
      // Read out of this install's own scaffold/package.json.
      assert.equal(plist("CFBundleShortVersionString"), "9.8.7");

      // The executable really is executable (double-clicking it is the whole
      // point), and is this install's own tray script with this port.
      const exe = join(contents, "MacOS", "Granted");
      assert.ok(statSync(exe).mode & 0o111, "the bundle's executable has its execute bits");
      const text = readFileSync(exe, "utf8");
      assert.ok(text.includes(join(fake.scaffold, "scripts", "macos", "granted-tray.sh")), "it runs this install's tray script");
      assert.match(text, new RegExp(`--port ${PORT}`));
      assert.match(text, /start --open-browser/, "one click starts the background server and opens Granted");

      // A real .icns, as the system reads it — not just a file with the right name.
      const { stdout: icnsInfo } = await execFileAsync("/usr/bin/file", [join(contents, "Resources", "granted.icns")]);
      assert.match(icnsInfo, /Mac OS X icon/);
      const { stdout: sizes } = await execFileAsync("/usr/bin/sips", [
        "-g",
        "pixelWidth",
        "-g",
        "pixelHeight",
        join(contents, "Resources", "granted.icns"),
      ]);
      assert.match(sizes, /pixelWidth: 256/);
      assert.match(sizes, /pixelHeight: 256/);

      // Nothing was added to the Dock: that was not asked for.
      assert.ok(!dockPlist().includes(fake.appPath), "the Dock was left alone");
    });

    test("icns: the .ico is converted by sips/iconutil alone, and a missing .ico is not fatal", async () => {
      const out = join(fake.root, "standalone.icns");
      const { stdout } = await launcher("icns", "--out", out);
      assert.equal(stdout.trim(), out);
      const { stdout: info } = await execFileAsync("/usr/bin/file", [out]);
      assert.match(info, /Mac OS X icon/);

      // With no icon to convert, the launcher is still created — it just
      // shows the generic app icon.
      const other = join(fake.root, "NoIcon");
      const { stdout: noIcon } = await execFileAsync(
        "/bin/bash",
        [fake.launcherScript, "install", "--port", String(PORT)],
        { env: { ...process.env, ...fake.env, GRANTED_APPLICATIONS_DIR: other, GRANTED_LAUNCHER_ICO: join(fake.root, "nope.ico") } },
      );
      assert.deepEqual(parseLauncherOutput(noIcon), { launcher: join(other, "Granted.app"), icon: false, dock: "skipped" });
      assert.ok(existsSync(join(other, "Granted.app", "Contents", "MacOS", "Granted")), "the launcher is still there");
      assert.ok(!existsSync(join(other, "Granted.app", "Contents", "Resources", "granted.icns")), "with no icon");
    });

    test("install --add-to-dock: one tile is added to the Dock's persistent-apps, and re-running it adds no second copy", async () => {
      const { stdout } = await launcher("install", "--port", String(PORT), "--add-to-dock");
      assert.deepEqual(parseLauncherOutput(stdout), { launcher: fake.appPath, icon: true, dock: "added" });
      const plist = dockPlist();
      assert.ok(plist.includes("persistent-apps"), "it went into persistent-apps");
      assert.ok(plist.includes(fake.appPath), "and names this launcher");
      assert.equal(plist.split(fake.appPath).length - 1, 1, "exactly one tile");

      const { stdout: again } = await launcher("install", "--port", String(PORT), "--add-to-dock");
      assert.deepEqual(parseLauncherOutput(again), { launcher: fake.appPath, icon: true, dock: "already" });
      assert.equal(dockPlist().split(fake.appPath).length - 1, 1, "still exactly one tile");
      const { stdout: inDock } = await launcher("in-dock");
      assert.deepEqual(JSON.parse(inDock.trim()), { inDock: true });
    });

    test("another app's Dock tile is left exactly as it was, whichever way the Dock spelled it", async () => {
      // Two tiles the Dock itself could have written: a file:// URL with
      // percent-encoding and a trailing slash (type 15, what the Dock saves),
      // and a plain path. Neither is Granted's, so neither may be touched.
      const other = "file:///Applications/Some%20Other%20App.app/";
      execFileSync("defaults", [
        "write",
        fake.dockDomain,
        "persistent-apps",
        "-array-add",
        `<dict><key>tile-data</key><dict><key>file-data</key><dict><key>_CFURLString</key><string>${other}</string><key>_CFURLStringType</key><integer>15</integer></dict></dict><key>tile-type</key><string>file-tile</string></dict>`,
      ]);
      await launcher("remove-from-dock");
      const plist = dockPlist();
      assert.ok(plist.includes(other), "the other app is still in the Dock");
      assert.ok(!plist.includes(fake.appPath), "and Granted is not");

      // The same spelling the Dock would use for Granted's own tile is
      // recognized as Granted's: add it by hand as a file:// URL, and the
      // script must find and remove exactly that one.
      const asUrl = `file://${fake.appPath.replace(/ /g, "%20")}/`;
      execFileSync("defaults", [
        "write",
        fake.dockDomain,
        "persistent-apps",
        "-array-add",
        `<dict><key>tile-data</key><dict><key>file-data</key><dict><key>_CFURLString</key><string>${asUrl}</string><key>_CFURLStringType</key><integer>15</integer></dict></dict><key>tile-type</key><string>file-tile</string></dict>`,
      ]);
      const { stdout: found } = await launcher("in-dock");
      assert.deepEqual(JSON.parse(found.trim()), { inDock: true }, "a file:// URL tile is Granted's too");
      const { stdout: removed } = await launcher("remove-from-dock");
      assert.deepEqual(JSON.parse(removed.trim()), { dock: "removed" });
      const after = dockPlist();
      assert.ok(after.includes(other), "the other app survived the removal");
      assert.ok(!after.includes(asUrl));
    });

    test("add-to-dock and remove-from-dock on their own, and removing what isn't there", async () => {
      const { stdout: add } = await launcher("add-to-dock");
      assert.deepEqual(JSON.parse(add.trim()), { dock: "added" });
      const { stdout: remove } = await launcher("remove-from-dock");
      assert.deepEqual(JSON.parse(remove.trim()), { dock: "removed" });
      const { stdout: absent } = await launcher("remove-from-dock");
      assert.deepEqual(JSON.parse(absent.trim()), { dock: "absent" });
    });

    test("something else already at ~/Applications/Granted.app is refused, not overwritten or deleted", async () => {
      const mine = join(fake.root, "SomeoneElse");
      const theirs = join(mine, "Granted.app");
      mkdirSync(join(theirs, "Contents"), { recursive: true });
      await writeFile(join(theirs, "Contents", "Info.plist"), "<plist><dict/></plist>", "utf8");
      await writeFile(join(theirs, "important.txt"), "not ours", "utf8");
      await assert.rejects(
        () =>
          execFileAsync("/bin/bash", [fake.launcherScript, "install"], {
            env: { ...process.env, ...fake.env, GRANTED_APPLICATIONS_DIR: mine },
          }),
        /isn't Granted's launcher/,
      );
      assert.equal(readFileSync(join(theirs, "important.txt"), "utf8"), "not ours", "it was left completely alone");
      // And `remove` refuses it too.
      await assert.rejects(
        () =>
          execFileAsync("/bin/bash", [fake.launcherScript, "remove"], {
            env: { ...process.env, ...fake.env, GRANTED_APPLICATIONS_DIR: mine },
          }),
        /isn't Granted's launcher/,
      );
      assert.ok(existsSync(theirs));
    });

    test("remove: its own bundle goes, and removing a launcher that isn't there is not an error", async () => {
      await launcher("install", "--port", String(PORT));
      const { stdout } = await launcher("remove");
      assert.deepEqual(JSON.parse(stdout.trim()), { removed: true });
      assert.ok(!existsSync(fake.appPath));
      const { stdout: again } = await launcher("remove");
      assert.deepEqual(JSON.parse(again.trim()), { removed: false });
    });

    test("running the launcher — what a double-click does — really starts the background server and opens Granted", async () => {
      await launcher("install", "--port", String(PORT));
      const exe = join(fake.appPath, "Contents", "MacOS", "Granted");

      // Exactly what Finder or the Dock does: run the bundle's executable.
      // It returns at once (it detaches the tray script on purpose), so what
      // it started has to be waited for afterwards.
      await execFileAsync(exe, [], { env: { ...process.env, ...fake.env }, timeout: 30_000 });

      // The real granted-tray.sh really started the real LaunchAgent, and the
      // server really answers.
      assert.equal(await until(() => probeGranted(`http://127.0.0.1:${PORT}/`, 3000), (p) => p === "granted"), "granted");
      const loaded = execFileSync("launchctl", ["print", `gui/${process.getuid?.() ?? 0}/${fake.label}`], { encoding: "utf8" });
      assert.match(loaded, /state = running/, "the throwaway LaunchAgent is running the server");
      assert.match(readFileSync(join(fake.root, "logs", `server-${PORT}.log`), "utf8"), /fake Granted listening/);

      // And it opened Granted: with no app-mode browser (GRANTED_APP_BROWSER
      // =none), open-granted.sh falls back to `open`, whose stand-in logs what
      // it was asked for.
      const opened = await until(
        async () => (existsSync(fake.openedLog) ? readFileSync(fake.openedLog, "utf8") : ""),
        (text) => text.includes(`http://localhost:${PORT}`),
        120_000,
      );
      assert.match(opened, new RegExp(`http://localhost:${PORT}`), "Granted was opened");

      // The launcher logs what it did, in the log folder the tray uses.
      assert.match(readFileSync(join(fake.root, "logs", "launcher.log"), "utf8"), new RegExp(`starting Granted on port ${PORT}`));

      // Leave nothing running or registered.
      execFileSync("/bin/bash", [join(fake.scaffold, "scripts", "macos", "granted-tray.sh"), "stop", "--port", String(PORT)], {
        stdio: "ignore",
        env: { ...process.env, ...fake.env },
      });
      assert.equal(await probeGranted(`http://127.0.0.1:${PORT}/`, 2000), "down");
    });

    test("a launcher whose install folder has gone says so instead of failing silently", async () => {
      const gone = join(fake.root, "Gone");
      await execFileAsync("/bin/bash", [fake.launcherScript, "install"], {
        env: { ...process.env, ...fake.env, GRANTED_APPLICATIONS_DIR: gone },
      });
      const exe = join(gone, "Granted.app", "Contents", "MacOS", "Granted");
      // Rewritten to point at a tray script that doesn't exist — the same
      // thing a deleted or moved install does to a real launcher.
      const text = readFileSync(exe, "utf8").replace(
        join(fake.scaffold, "scripts", "macos", "granted-tray.sh"),
        join(fake.root, "deleted", "granted-tray.sh"),
      );
      await writeFile(exe, text, { mode: 0o755 });
      await assert.rejects(() => execFileAsync(exe, [], { env: { ...process.env, ...fake.env } }));
      assert.match(readFileSync(join(fake.root, "logs", "launcher.log"), "utf8"), /is gone -- Granted was moved or deleted/);
    });
  },
);
