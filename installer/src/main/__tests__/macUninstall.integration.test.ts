/**
 * Integration: the REAL scaffold/scripts/macos/uninstall.sh, run against
 * throwaway Granted installs — everything it refuses to delete, and a full
 * set-up install (background server under its own LaunchAgent, an
 * ~/Applications launcher, a Dock tile, settings and logs) really taken apart.
 * The macOS counterpart of uninstall.integration.test.ts.
 *
 * Nothing here touches anything real, by the same means the other macOS
 * integration tests use: a throwaway LaunchAgent label (GRANTED_LAUNCH_LABEL)
 * whose plist lives in a temp folder, a throwaway Applications folder, a
 * throwaway `defaults` domain for "the Dock" with no Dock restart, temp
 * settings and log folders, and a stand-in for `open`. The user's own Granted
 * install, LaunchAgents, Applications folder, Dock, settings and logs are
 * never reachable from here.
 *
 * The file-shape checks run anywhere; everything that runs the script is macOS
 * only.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync, spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, openSync, closeSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { probeGranted } from "../openGranted";

const execFileAsync = promisify(execFile);

// `npm test` runs from installer/; the scripts live in scaffold/.
const MACOS_SCRIPTS = resolve(process.cwd(), "..", "scaffold", "scripts", "macos");
const WINDOWS_SCRIPTS = resolve(process.cwd(), "..", "scaffold", "scripts", "windows");
const UNINSTALL_SCRIPT = join(MACOS_SCRIPTS, "uninstall.sh");
const TRAY_SCRIPT = join(MACOS_SCRIPTS, "granted-tray.sh");
const OPEN_SCRIPT = join(MACOS_SCRIPTS, "open-granted.sh");
const LAUNCHER_SCRIPT = join(MACOS_SCRIPTS, "applications-launcher.sh");
const MENUBAR_PKG = join(MACOS_SCRIPTS, "menubar");
const HELPER_SOURCE = join(MENUBAR_PKG, "Sources", "GrantedMenuBar", "main.swift");
const ICO = join(WINDOWS_SCRIPTS, "granted.ico");
const GRANTED_HTML = "<title>Granted — federal funding intelligence for everyone</title>";
// Not 3000, and not macTray's 3977 or macLauncher's 3975: a real Granted (or
// another test's fake one) must never be mistaken for this one's.
const PORT = 3973;

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

/** Whether `swift` can build (the Xcode Command Line Tools are installed). */
function hasSwift(): boolean {
  try {
    execFileSync("swift", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** Whether this process is in a GUI (Aqua) session, which NSStatusBar needs. */
function inAquaSession(): boolean {
  try {
    return execFileSync("launchctl", ["managername"], { encoding: "utf8" }).trim() === "Aqua";
  } catch {
    return false;
  }
}

interface Box {
  root: string;
  installDir: string;
  scaffold: string;
  uninstallScript: string;
  trayScript: string;
  launcherScript: string;
  label: string;
  plistPath: string;
  supportDir: string;
  logDir: string;
  applicationsDir: string;
  appPath: string;
  dockDomain: string;
  backupDir: string;
  /** What the stand-in `open` was asked to open. */
  openedLog: string;
  env: Record<string, string>;
  agentLoaded: () => boolean;
}

interface BoxOptions {
  /** The install folder's own name (default "granted-throwaway"). */
  name?: string;
  /** The top-level name in scaffold/package.json (anything but "granted" isn't a Granted install). */
  packageName?: string;
  /** Whether to write the installer's .git/granted-installer marker (default: yes). */
  marker?: boolean;
  /** A box that shares this one's settings, logs, Applications folder and Dock. */
  sharedWith?: Box;
  /** How the script asks: "yes", "no", or a command. */
  ask?: string;
}

/**
 * A throwaway Granted install: the REAL macOS scripts, a `npm run dev` that is
 * a tiny Node server, API-key files to be kept a copy of, the installer's
 * marker, and its own settings, logs, Applications folder, "Dock" and
 * LaunchAgent label.
 */
async function makeBox(root: string, options: BoxOptions = {}): Promise<Box> {
  // realpath: mkdtemp hands back /var/folders/…, a symlink to
  // /private/var/folders/…, and the scripts resolve their own location with
  // `pwd -P` — so what they report is the resolved path.
  const base = realpathSync(await mkdtemp(join(root, "box-")));
  const installDir = join(base, options.name ?? "granted-throwaway");
  const scaffold = join(installDir, "scaffold");
  mkdirSync(join(scaffold, "scripts", "macos"), { recursive: true });
  mkdirSync(join(scaffold, "scripts", "windows"), { recursive: true });
  mkdirSync(join(scaffold, "data", "local"), { recursive: true });
  mkdirSync(join(installDir, ".git"), { recursive: true });
  for (const from of [UNINSTALL_SCRIPT, TRAY_SCRIPT, OPEN_SCRIPT, LAUNCHER_SCRIPT]) {
    await writeFile(join(scaffold, "scripts", "macos", from.split("/").pop() as string), readFileSync(from, "utf8"), "utf8");
  }
  await writeFile(join(scaffold, "scripts", "windows", "granted.ico"), readFileSync(ICO));
  await writeFile(
    join(scaffold, "package.json"),
    // "granted", not "fake-granted": the uninstaller refuses to delete a
    // folder whose scaffold/package.json isn't Granted's, so a test install
    // has to be named the way a real one is.
    JSON.stringify({ name: options.packageName ?? "granted", private: true, version: "9.9.9", scripts: { dev: "node fake-dev.js" } }),
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
  // The two files the uninstaller offers to keep a copy of.
  await writeFile(join(scaffold, ".env.local"), "OPENAI_API_KEY=sk-uninstall-test-0000000000\nLLM_API_KEY=sk-only-here-0000000000\n", "utf8");
  await writeFile(join(scaffold, "data", "local", "llm-config.json"), JSON.stringify({ cloud: { apiKey: "sk-in-settings-0000000000" } }), "utf8");
  if (options.marker !== false) await writeFile(join(installDir, ".git", "granted-installer"), "test\n", "utf8");

  const shared = options.sharedWith;
  const supportDir = shared?.supportDir ?? join(base, "Application Support", "Granted");
  const logDir = shared?.logDir ?? join(base, "Logs", "Granted");
  const applicationsDir = shared?.applicationsDir ?? join(base, "Applications");
  const dockDomain = shared?.dockDomain ?? join(base, "testdock");
  mkdirSync(supportDir, { recursive: true });
  mkdirSync(logDir, { recursive: true });
  mkdirSync(applicationsDir, { recursive: true });
  writeFileSync(join(supportDir, "settings.json"), JSON.stringify({ openIn: "window" }), "utf8");
  writeFileSync(join(logDir, `server-${PORT}.log`), "an old log line\n", "utf8");
  const launchAgentsDir = shared ? shared.env["GRANTED_LAUNCH_AGENTS_DIR"] : join(base, "LaunchAgents");
  mkdirSync(launchAgentsDir, { recursive: true });

  // A stand-in for `open`, so nothing a test opens reaches a real browser.
  const openedLog = join(base, "opened.log");
  const openCmd = join(base, "fake-open.sh");
  await writeFile(openCmd, `#!/bin/sh\nprintf '%s\\n' "$@" >> ${JSON.stringify(openedLog)}\n`, { mode: 0o755 });

  const label = `com.granted.test.${randomUUID()}`;
  const env: Record<string, string> = {
    GRANTED_LAUNCH_LABEL: label,
    GRANTED_LAUNCH_AGENTS_DIR: launchAgentsDir,
    GRANTED_LOG_DIR: logDir,
    GRANTED_SETTINGS_PATH: join(supportDir, "settings.json"),
    GRANTED_APPLICATIONS_DIR: applicationsDir,
    GRANTED_DOCK_DOMAIN: dockDomain,
    // The user's real Dock must never be restarted by a test.
    GRANTED_DOCK_RELOAD_CMD: "none",
    GRANTED_MENUBAR_HELPER: "none",
    GRANTED_APP_BROWSER: "none",
    GRANTED_OPEN_CMD: openCmd,
    GRANTED_LAUNCHER_ALERT: "none",
    // An osascript dialog would wait for a click that never comes.
    GRANTED_UNINSTALL_ASK_CMD: options.ask ?? "no",
    // A kept copy of the keys goes in here, never in the real Documents
    // folder of whoever is running the tests.
    GRANTED_UNINSTALL_BACKUP_DIR: join(base, "kept-keys"),
  };
  const domain = `gui/${process.getuid?.() ?? 0}/${label}`;
  return {
    root: base,
    installDir,
    scaffold,
    uninstallScript: join(scaffold, "scripts", "macos", "uninstall.sh"),
    trayScript: join(scaffold, "scripts", "macos", "granted-tray.sh"),
    launcherScript: join(scaffold, "scripts", "macos", "applications-launcher.sh"),
    label,
    plistPath: join(launchAgentsDir, `${label}.plist`),
    supportDir,
    logDir,
    applicationsDir,
    appPath: join(applicationsDir, "Granted.app"),
    dockDomain,
    backupDir: join(base, "kept-keys"),
    openedLog,
    env,
    agentLoaded: () => {
      try {
        execFileSync("launchctl", ["print", domain], { stdio: "ignore" });
        return true;
      } catch {
        return false;
      }
    },
  };
}

/** Runs the box's own uninstall.sh; returns its exit code and the JSON line it printed. */
async function uninstall(box: Box, args: string[] = [], extraEnv: Record<string, string> = {}): Promise<{ code: number; result: Record<string, unknown> }> {
  const parse = (stdout: string | undefined): Record<string, unknown> => {
    try {
      return JSON.parse((stdout ?? "").trim().split(/\r?\n/).filter(Boolean).pop() ?? "{}") as Record<string, unknown>;
    } catch {
      return {};
    }
  };
  try {
    const { stdout } = await execFileAsync("/bin/bash", [box.uninstallScript, "--port", String(PORT), ...args], {
      env: { ...process.env, ...box.env, ...extraEnv },
      timeout: 180_000,
    });
    return { code: 0, result: parse(stdout) };
  } catch (err) {
    const e = err as { code?: number; stdout?: string };
    return { code: typeof e.code === "number" ? e.code : -1, result: parse(e.stdout) };
  }
}

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.com", ...args], { cwd, encoding: "utf8" });

// --- file-shape checks (any platform) --------------------------------------

test(
  "uninstall.sh refuses anything that isn't an install the installer made, and never deletes a folder it hasn't moved first",
  { skip: !existsSync(UNINSTALL_SCRIPT) && "run from installer/" },
  () => {
    const script = readFileSync(UNINSTALL_SCRIPT, "utf8");
    // The code only, with the comments stripped: the header explains at length
    // what this script deliberately does NOT do, and those sentences must not
    // be mistaken for the thing itself.
    const code = script
      .split("\n")
      .filter((line) => !/^\s*#/.test(line))
      .join("\n");

    // The marker this whole macOS arc uses for "our installer made this" —
    // the one check that keeps a developer's own checkout out of this.
    assert.match(code, /MARKER="\$INSTALL_DIR\/\.git\/granted-installer"/);
    assert.match(code, /not-made-by-installer/);
    // And the other refusals, each with its own reason. ("already-gone" is not
    // one of them: a folder deleted by hand is removed:true and exit 0, as in
    // uninstall.ps1 — see the tests further down.)
    for (const reason of ["is-a-link", "not-a-granted-install", "unsaved-work", "files-in-use", "access-denied", "cancelled"]) {
      assert.ok(code.includes(reason), `refuses with reason "${reason}"`);
    }
    // Moved aside FIRST, deleted after — the ordering that keeps a failure
    // from leaving a half-deleted install (see the script's header for what
    // this does and does not buy on macOS).
    const moved = code.indexOf('mv -- "$INSTALL_DIR" "$TRASH"');
    const deleted = code.indexOf('rm -rf -- "$TRASH"');
    assert.ok(moved > 0, "the folder is moved aside");
    assert.ok(deleted > moved, "and only deleted after it has moved");
    assert.ok(!code.includes('rm -rf -- "$INSTALL_DIR"'), "the install folder itself is never deleted in place");
    // Not the Trash: that needs Finder automation permission, which a prompt
    // nobody can answer would block (see the header).
    assert.ok(!/tell application "Finder"/.test(code), "no Finder automation");
    // Stopping Granted, removing the launcher and the Dock tile are all done
    // by the scripts that own them, never reimplemented here.
    assert.match(code, /"\$TRAY_SCRIPT" stop --port/);
    assert.match(code, /"\$LAUNCHER_SCRIPT" remove-from-dock/);
    assert.match(code, /"\$LAUNCHER_SCRIPT" remove/);
    assert.ok(!code.includes("persistent-apps"), "the Dock is applications-launcher.sh's business, not this script's");
    // A --backup-dir inside the folder being deleted is bad input, not a
    // backup: the move-and-delete it is meant to survive would destroy it,
    // and the run would report keeping it anyway.
    assert.match(code, /BACKUP_DIR#"\$INSTALL_DIR"\//);
    // Asked of the filesystem as well as of the two strings, so that another
    // NAME for the same folder — a different capitalisation, a symlinked
    // parent, a sideways ".." — is caught too.
    assert.match(code, /stat -f '%d:%i'/, "directory identity, not spelling");
    assert.match(code, /existing_ancestor/);
    // And the check that needs no prediction at all: whatever got past the
    // above, keptKeys only ever names a folder that is really there.
    assert.match(code, /kept_keys_json\(\) \{\n\s*if \[ -n "\$KEPT_KEYS" \] && \[ -d "\$KEPT_KEYS" \]/);
    assert.ok(
      !/"\$\(\[ -n "\$KEPT_KEYS" \] && json_string/.test(code),
      "no report site names the backup folder without checking it is there",
    );
    // Bad input answers in JSON too, not only on stderr: the app reads this
    // script's output from a log file and has no stderr to look at.
    assert.match(code, /"reason":"bad-input"/);
    // Whether a plist or a launcher belongs to THIS install is a bounded
    // match, so an install whose path merely CONTAINS another's is not
    // mistaken for it.
    assert.match(code, /grep -qF ">\$SCAFFOLD_DIR<"/);
    assert.match(code, /grep -qF "TRAY_SCRIPT='\$TRAY_SCRIPT'"/);
    // An explicit --keep-keys / --no-keep-keys decides it, rather than being
    // overwritten by whatever the interactive dialog was answered.
    assert.match(code, /--keep-keys\) KEEP_KEYS=1; KEEP_KEYS_GIVEN=1/);
    assert.match(code, /--no-keep-keys\) KEEP_KEYS=0; KEEP_KEYS_GIVEN=1/);
    assert.match(code, /\[ "\$KEEP_KEYS_GIVEN" = "0" \]/);
    // Every `rm -rf` of a path a caller can choose is guarded.
    assert.match(code, /PROTECTED_DIRS=\(/);
    assert.match(code, /basename -- "\$SUPPORT_DIR"\)" = "Granted"/);
    assert.match(code, /basename -- "\$LOG_DIR"\)" = "Granted"/);
    // --quiet refuses unsaved work on its own; only --force goes ahead.
    assert.match(code, /if \[ "\$QUIET" = "1" \]; then\n\s*if \[ "\$FORCE" != "1" \]; then/);
    // And the asking is overridable, so no test can ever be left waiting on a
    // dialog.
    assert.match(code, /GRANTED_UNINSTALL_ASK_CMD/);
    // A failure anywhere has to reach the ERR trap and be reported as JSON:
    // bash does not run that trap inside a shell function without errtrace.
    assert.match(code, /^set -o errtrace$/m);
    // REGRESSION: errtrace also means the trap fires inside a command
    // SUBSTITUTION, where an enclosing `if` does not suppress it. Capturing
    // mv's message that way put this script's own error JSON inside the
    // message it then reported.
    assert.ok(!/move_error="\$\(mv /.test(code), "mv's message is read from a file, not from a command substitution");
  },
);

test(
  "granted-tray.sh's uninstall starts the uninstaller detached, with its log outside the folders the uninstall deletes",
  { skip: !existsSync(TRAY_SCRIPT) && "run from installer/" },
  () => {
    const script = readFileSync(TRAY_SCRIPT, "utf8");
    const code = script
      .split("\n")
      .filter((line) => !/^\s*#/.test(line))
      .join("\n");
    assert.match(code, /nohup \/bin\/bash "\$UNINSTALL_SCRIPT" --confirmed --port "\$PORT"/);
    assert.match(code, /GRANTED_UNINSTALL_LOG:-\$\{TMPDIR:-\/tmp\}/, "the log is in the temporary folder");
    assert.ok(!/GRANTED_UNINSTALL_LOG:-\$LOG_DIR/.test(code), "never in the log folder the uninstall removes");
    assert.match(code, /no-uninstaller/, "an install too old to have the script says so");
  },
);

test(
  "the menu-bar helper asks before it uninstalls anything, and deletes nothing itself",
  { skip: !existsSync(HELPER_SOURCE) && "run from installer/" },
  () => {
    const source = readFileSync(HELPER_SOURCE, "utf8");
    assert.ok(source.includes('title: "Uninstall Granted…"'), "the menu has an Uninstall item");
    // A real confirmation, with the safe answer as the default button.
    assert.match(source, /NSAlert\(\)/);
    assert.match(source, /alertStyle = \.critical/);
    assert.match(source, /addButton\(withTitle: "Cancel"\)[\s\S]*addButton\(withTitle: "Uninstall"\)/);
    assert.match(source, /== \.alertSecondButtonReturn/, "only the second button (Uninstall) goes ahead");
    assert.match(source, /guard !quitting, !uninstalling, confirmUninstall\(\) else \{ return \}/);
    // It starts the script through granted-tray.sh and does no deleting of its
    // own.
    assert.match(source, /tray\(\["uninstall"\]/);
    assert.ok(!source.includes("removeItem(atPath: self.installDir"), "the helper removes nothing itself");
    // Polling stops, so an uninstall is never reported as a crash.
    assert.match(source, /guard !quitting, !uninstalling, !polling else \{ return \}/);
  },
);

// --- the real thing (macOS) ------------------------------------------------

describe(
  "uninstall.sh, run for real against throwaway installs",
  { skip: (process.platform !== "darwin" || !existsSync(UNINSTALL_SCRIPT)) && "macOS only, run from installer/" },
  () => {
    let root: string;
    const boxes: Box[] = [];
    const started: ChildProcess[] = [];

    const box = async (options: BoxOptions = {}): Promise<Box> => {
      const made = await makeBox(root, options);
      boxes.push(made);
      return made;
    };

    /** This box's throwaway Dock, as `defaults` sees it. */
    const dockPlist = (b: Box): string => {
      try {
        return execFileSync("defaults", ["export", b.dockDomain, "-"], { encoding: "utf8" });
      } catch {
        return "";
      }
    };

    before(async () => {
      root = realpathSync(await mkdtemp(join(tmpdir(), "granted-mac-uninstall-it-")));
    });

    after(async () => {
      for (const child of started) if (child.exitCode === null) child.kill("SIGKILL");
      // Whatever any test left running or registered, on the machine running
      // the tests: stopped and booted out, directly as well as through the
      // script.
      for (const b of boxes) {
        try {
          if (existsSync(b.trayScript)) {
            execFileSync("/bin/bash", [b.trayScript, "stop", "--port", String(PORT)], { stdio: "ignore", env: { ...process.env, ...b.env } });
          }
        } catch {
          /* nothing was running */
        }
        try {
          execFileSync("launchctl", ["bootout", `gui/${process.getuid?.() ?? 0}/${b.label}`], { stdio: "ignore" });
        } catch {
          /* already gone */
        }
      }
      await rm(root, { recursive: true, force: true, maxRetries: 5 });
    });

    test("--check reports what an uninstall would find, and changes nothing", async () => {
      const b = await box();
      const { code, result } = await uninstall(b, ["--check"]);
      assert.equal(code, 0, JSON.stringify(result));
      assert.equal(result["check"], true);
      assert.equal(result["installDir"], b.installDir);
      assert.equal(result["grantedInstall"], true);
      assert.equal(result["installerMade"], true);
      assert.deepEqual(result["unsaved"], []);
      assert.deepEqual(result["keyFiles"], [join(b.scaffold, ".env.local"), join(b.scaffold, "data", "local", "llm-config.json")]);
      assert.equal(result["launchAgent"], "none");
      assert.equal(result["launcher"], "none");
      // Where a kept copy would go: the throwaway folder this test points it
      // at, never the real Documents folder (GRANTED_UNINSTALL_BACKUP_DIR).
      assert.equal(result["backupDir"], join(b.root, "kept-keys"));
      assert.ok(existsSync(join(b.scaffold, "package.json")), "nothing was deleted");
      assert.ok(existsSync(join(b.supportDir, "settings.json")));
    });

    test("a folder the installer didn't make is never deleted (exit 2), whatever --force says", async () => {
      const b = await box({ marker: false });
      const { code, result } = await uninstall(b, ["--quiet"]);
      assert.equal(code, 2);
      assert.equal(result["reason"], "not-made-by-installer");
      assert.ok(existsSync(join(b.scaffold, "package.json")), "someone's own checkout is left alone");
      // --force is about unsaved work, and must not override this.
      const forced = await uninstall(b, ["--quiet", "--force"]);
      assert.equal(forced.code, 2);
      assert.equal(forced.result["reason"], "not-made-by-installer");
      assert.ok(existsSync(join(b.scaffold, "package.json")));
      assert.equal((await uninstall(b, ["--check"])).result["installerMade"], false);
    });

    test("a folder that isn't a Granted install is never deleted (exit 2)", async () => {
      const b = await box({ packageName: "my-own-project" });
      const { code, result } = await uninstall(b, ["--quiet"]);
      assert.equal(code, 2);
      assert.equal(result["reason"], "not-a-granted-install");
      assert.ok(existsSync(join(b.scaffold, "package.json")));
    });

    test("a symlink to an install is refused, never followed and deleted at the other end", async () => {
      const b = await box();
      const link = join(b.root, "granted-link");
      symlinkSync(b.installDir, link);
      const { code, result } = await uninstall(b, ["--quiet", "--install-dir", link]);
      assert.equal(code, 2);
      assert.equal(result["reason"], "is-a-link");
      assert.ok(existsSync(join(b.scaffold, ".env.local")), "the real files are untouched");
      assert.ok(existsSync(link), "and so is the link");
    });

    // REGRESSION (review): this used to exit 2 with removed:false and clean up
    // NOTHING, leaving the LaunchAgent, the launcher, its Dock tile and the
    // shared settings and logs orphaned with nothing left that would ever
    // remove them — both ways in went with the folder. uninstall.ps1 treats
    // this case as removed:true and tidies up, and so does this now.
    test("a folder already deleted by hand: removed:true (exit 0), and what the install left elsewhere goes too", async () => {
      const gone = await box();
      // The LaunchAgent, the launcher and its Dock tile are all in place, and
      // all belong to THIS install.
      const plist = execFileSync("/bin/bash", [gone.trayScript, "plist", "--port", String(PORT)], {
        encoding: "utf8",
        env: { ...process.env, ...gone.env },
      });
      await writeFile(gone.plistPath, plist, "utf8");
      await execFileAsync("/bin/bash", [gone.launcherScript, "install", "--port", String(PORT), "--add-to-dock"], {
        env: { ...process.env, ...gone.env },
        timeout: 120_000,
      });
      assert.ok(existsSync(gone.appPath));
      assert.ok(dockPlist(gone).includes(gone.appPath));

      await rm(gone.installDir, { recursive: true, force: true });
      // Asked through another copy of the script, with --install-dir: the one
      // inside the folder went with it (Windows keeps a copy outside the
      // install for its Installed-apps entry; on macOS both ways in — the
      // menu-bar icon and the app's own Settings — are gone with the folder
      // too, so this is the state a person reaches from a terminal). The
      // launcher is removed by the copy of applications-launcher.sh beside the
      // script that is running, there being no moved-aside folder to use.
      const other = await box();
      const { code, result } = await uninstall({ ...gone, uninstallScript: other.uninstallScript }, ["--quiet", "--install-dir", gone.installDir]);
      assert.equal(code, 0, JSON.stringify(result));
      assert.equal(result["removed"], true);
      assert.equal(result["alreadyGone"], true);
      assert.equal(result["removedLaunchAgent"], true);
      assert.equal(result["removedLauncher"], true);
      assert.equal(result["removedFromDock"], true);
      assert.equal(result["removedSettings"], true);
      assert.equal(result["removedLogs"], true);
      assert.equal(existsSync(gone.plistPath), false, "the orphaned LaunchAgent plist is gone");
      assert.equal(existsSync(gone.appPath), false, "and the orphaned launcher");
      assert.ok(!dockPlist(gone).includes(gone.appPath), "and its Dock tile");
      assert.equal(existsSync(gone.supportDir), false, "and the settings");
      assert.equal(existsSync(gone.logDir), false, "and the logs");
      assert.ok(existsSync(join(other.scaffold, "package.json")), "and the install it was run from is untouched");
    });

    // The one place this is deliberately stricter than uninstall.ps1, which has
    // Windows' Installed-apps list to count instead: with the folder gone there
    // is no marker left to read, so the shared settings and logs go only when
    // something still points at that exact folder.
    test("a folder that was never a Granted install: nothing points at it, so the shared settings stay", async () => {
      const b = await box();
      const typo = join(b.root, "granted-typo-no-such-folder");
      const { code, result } = await uninstall(b, ["--quiet", "--install-dir", typo]);
      assert.equal(code, 0, JSON.stringify(result));
      assert.equal(result["alreadyGone"], true);
      assert.equal(result["removedSettings"], false, "another install's settings are not this one's to delete");
      assert.equal(result["removedLogs"], false);
      assert.ok(existsSync(join(b.supportDir, "settings.json")));
      assert.ok(existsSync(b.logDir));
      assert.ok(existsSync(join(b.scaffold, "package.json")), "and the real install beside it is untouched");
    });

    test("work that isn't on GitHub: --quiet refuses it (exit 4) and only --force deletes it", async () => {
      const b = await box();
      // A real git repo this time: committed clean, then edited.
      await rm(join(b.installDir, ".git"), { recursive: true, force: true });
      await writeFile(join(b.installDir, ".gitignore"), "node_modules/\n.env.local\ndata/\n", "utf8");
      git(b.installDir, "init", "-q");
      git(b.installDir, "add", "-A");
      git(b.installDir, "commit", "-q", "-m", "clean");
      await writeFile(join(b.installDir, ".git", "granted-installer"), "test\n", "utf8");
      await writeFile(join(b.scaffold, "fake-dev.js"), "// my local change\n", "utf8");

      const { code, result } = await uninstall(b, ["--quiet"]);
      assert.equal(code, 4, JSON.stringify(result));
      assert.equal(result["reason"], "unsaved-work");
      const unsaved = JSON.stringify(result["unsaved"]);
      assert.match(unsaved, /changed or new files/);
      assert.match(unsaved, /commits that aren't pushed/, "a local-only commit counts too (no remote here)");
      assert.ok(existsSync(join(b.scaffold, "fake-dev.js")), "nothing was deleted");
      // --check says the same thing, so a UI can warn about it first.
      assert.match(JSON.stringify((await uninstall(b, ["--check"])).result["unsaved"]), /changed or new files/);

      const forced = await uninstall(b, ["--quiet", "--force"]);
      assert.equal(forced.code, 0, JSON.stringify(forced.result));
      assert.equal(existsSync(b.installDir), false);
    });

    test("a stash counts as unsaved work too", async () => {
      const b = await box();
      await rm(join(b.installDir, ".git"), { recursive: true, force: true });
      await writeFile(join(b.installDir, ".gitignore"), "node_modules/\n.env.local\ndata/\n", "utf8");
      git(b.installDir, "init", "-q");
      git(b.installDir, "add", "-A");
      git(b.installDir, "commit", "-q", "-m", "clean");
      await writeFile(join(b.scaffold, "fake-dev.js"), "// stashed\n", "utf8");
      git(b.installDir, "stash", "-q");
      await writeFile(join(b.installDir, ".git", "granted-installer"), "test\n", "utf8");
      const { code, result } = await uninstall(b, ["--quiet"]);
      assert.equal(code, 4, JSON.stringify(result));
      assert.match(JSON.stringify(result["unsaved"]), /stashed changes \(1\)/);
    });

    test("asked rather than told: no cancels and deletes nothing, yes goes ahead — including the second question about unsaved work", async () => {
      const asked = join(root, `asked-${randomUUID()}.log`);
      const askNo = join(root, `ask-no-${randomUUID()}.sh`);
      const askYes = join(root, `ask-yes-${randomUUID()}.sh`);
      await writeFile(askNo, `#!/bin/sh\nprintf '%s\\n' "$1" >> ${JSON.stringify(asked)}\nexit 1\n`, { mode: 0o755 });
      await writeFile(askYes, `#!/bin/sh\nprintf '%s\\n' "$1" >> ${JSON.stringify(asked)}\nexit 0\n`, { mode: 0o755 });

      const cancelled = await box({ ask: askNo });
      const no = await uninstall(cancelled, []);
      assert.equal(no.code, 1);
      assert.equal(no.result["reason"], "cancelled");
      assert.ok(existsSync(join(cancelled.scaffold, "package.json")), "nothing was deleted");
      assert.match(readFileSync(asked, "utf8"), /Uninstall Granted\?/);

      // A dirty folder, answered yes twice: the question about unsaved work is
      // asked as well, not only the first one.
      const dirty = await box({ ask: askYes });
      await rm(join(dirty.installDir, ".git"), { recursive: true, force: true });
      git(dirty.installDir, "init", "-q");
      await writeFile(join(dirty.installDir, ".git", "granted-installer"), "test\n", "utf8");
      const yes = await uninstall(dirty, ["--backup-dir", dirty.backupDir]);
      assert.equal(yes.code, 0, JSON.stringify(yes.result));
      assert.equal(existsSync(dirty.installDir), false);
      const questions = readFileSync(asked, "utf8");
      assert.match(questions, /Uninstall Granted anyway\?/, "asked again about the unsaved work");
      assert.match(questions, /Delete your API keys with Granted\?/, "and about the keys");
      // Answering "yes" to the keys question is answering "delete them".
      assert.equal(yes.result["keptKeys"], null);
      assert.equal(existsSync(dirty.backupDir), false);

      // --confirmed skips only the first question (what the menu-bar item's
      // own alert has already asked), and still asks about the keys.
      const confirmed = await box({ ask: askNo });
      const after = await uninstall(confirmed, ["--confirmed", "--backup-dir", confirmed.backupDir]);
      assert.equal(after.code, 0, JSON.stringify(after.result));
      assert.equal(existsSync(confirmed.installDir), false);
      assert.equal(after.result["keptKeys"], confirmed.backupDir, "a No to deleting the keys keeps a copy");
      assert.match(readFileSync(join(confirmed.backupDir, ".env.local"), "utf8"), /sk-uninstall-test-0000000000/);
    });

    test("--quiet keeps a copy of the API keys by default, and --no-keep-keys keeps none", async () => {
      const kept = await box();
      const withCopy = await uninstall(kept, ["--quiet", "--backup-dir", kept.backupDir]);
      assert.equal(withCopy.code, 0, JSON.stringify(withCopy.result));
      assert.equal(withCopy.result["keptKeys"], kept.backupDir);
      // REGRESSION (the Windows script's own): every key, wherever it was.
      const env = readFileSync(join(kept.backupDir, ".env.local"), "utf8");
      assert.match(env, /^OPENAI_API_KEY=sk-uninstall-test-0000000000$/m);
      assert.match(env, /^LLM_API_KEY=sk-only-here-0000000000$/m);
      assert.match(readFileSync(join(kept.backupDir, "llm-config.json"), "utf8"), /sk-in-settings/);
      // And the copy is outside the folder that was deleted.
      assert.equal(existsSync(kept.installDir), false);
      assert.ok(kept.backupDir.startsWith(kept.root) && !kept.backupDir.startsWith(kept.installDir));

      const none = await box();
      const without = await uninstall(none, ["--quiet", "--no-keep-keys", "--backup-dir", none.backupDir]);
      assert.equal(without.code, 0);
      assert.equal(without.result["keptKeys"], null);
      assert.equal(existsSync(none.backupDir), false);
    });

    // REGRESSION (review): a --backup-dir inside the install folder was copied
    // to, then destroyed by the very move-and-delete it was meant to survive —
    // and the run still exited 0 and reported {"keptKeys":"<that path>"}, for a
    // path that no longer existed. The script's whole promise about the keys is
    // that they are somewhere safe before anything is deleted, so this is bad
    // input and is refused as such.
    test("a --backup-dir inside the install folder is a usage error (64), and nothing is deleted", async () => {
      const b = await box();
      for (const backup of [join(b.installDir, "kept-inside"), b.installDir, join(b.scaffold, "keys")]) {
        const { code, result } = await uninstall(b, ["--quiet", "--force", "--backup-dir", backup]);
        assert.equal(code, 64, `${backup}: ${JSON.stringify(result)}`);
        assert.ok(existsSync(join(b.scaffold, "package.json")), "nothing was deleted");
        assert.ok(existsSync(join(b.scaffold, ".env.local")), "and the keys are still where they were");
      }
      // Said plainly, on stderr, the way every other bad argument here is.
      await assert.rejects(
        () =>
          execFileAsync("/bin/bash", [b.uninstallScript, "--quiet", "--port", String(PORT), "--backup-dir", join(b.installDir, "kept-inside")], {
            env: { ...process.env, ...b.env },
            timeout: 60_000,
          }),
        (err: { stderr?: string }) => /has to go outside the folder being deleted/.test(err.stderr ?? ""),
      );
      // A relative one is resolved before it is judged, rather than slipping
      // through and then being resolved against the wrong folder.
      const relative = await execFileAsync("/bin/bash", ["-c", `cd ${JSON.stringify(b.installDir)} && /bin/bash ${JSON.stringify(b.uninstallScript)} --quiet --backup-dir kept-rel; echo "exit=$?"`], {
        env: { ...process.env, ...b.env },
        timeout: 60_000,
      });
      assert.match(relative.stdout, /exit=64/);
      // And a sibling whose name merely STARTS with the install's is fine.
      const sibling = await uninstall(b, ["--check", "--backup-dir", `${b.installDir}-backup`]);
      assert.equal(sibling.code, 0, JSON.stringify(sibling.result));
      assert.equal(sibling.result["backupDir"], `${b.installDir}-backup`);
      assert.ok(existsSync(join(b.scaffold, "package.json")));
    });

    // REGRESSION (review, round 3): the containment check above was textual, so
    // it only caught a --backup-dir SPELLED as a path under the install folder.
    // Every other name for the same place went straight through, had the keys
    // copied into it, and was destroyed by the move-and-delete — and the run
    // still exited 0 reporting keptKeys at a path that no longer existed. Three
    // shapes were reproduced on this Mac, all of which the check now resolves
    // through by asking the filesystem for each directory's device and inode
    // rather than comparing two strings.
    test("a --backup-dir that is another NAME for a folder inside the install is refused too (64)", async () => {
      // 1. A different capitalisation. The volume these run on is
      //    case-insensitive, so "<base>/GRANTED" and "<base>/granted" are one
      //    folder — which `stat` confirms by reporting one inode for both, and
      //    which a string comparison cannot see at all.
      const folded = await box({ name: "granted-case" });
      const upper = join(folded.root, "GRANTED-CASE", "kept-inside");
      if (existsSync(join(folded.root, "GRANTED-CASE"))) {
        const { code, result } = await uninstall(folded, ["--quiet", "--force", "--backup-dir", upper]);
        assert.equal(code, 64, `${upper}: ${JSON.stringify(result)}`);
        assert.equal(result["reason"], "bad-input");
        assert.ok(existsSync(join(folded.scaffold, "package.json")), "nothing was deleted");
        assert.ok(existsSync(join(folded.scaffold, ".env.local")), "and the keys are still where they were");
      }

      // 2. A symlinked parent pointing at the install folder. `[ -d ]` follows
      //    it, so the copy really would land inside the install.
      const linked = await box();
      const link = join(linked.root, "link-to-install");
      symlinkSync(linked.installDir, link);
      const viaLink = await uninstall(linked, ["--quiet", "--force", "--backup-dir", join(link, "kept-inside")]);
      assert.equal(viaLink.code, 64, JSON.stringify(viaLink.result));
      assert.equal(viaLink.result["reason"], "bad-input");
      assert.ok(existsSync(join(linked.scaffold, "package.json")), "nothing was deleted");
      assert.ok(existsSync(join(linked.scaffold, ".env.local")), "and the keys are still where they were");

      // 3. A sideways ".." that climbs out of the install folder and back in.
      const sideways = await box();
      mkdirSync(join(sideways.root, "sideways"), { recursive: true });
      const viaDotDot = await uninstall(sideways, [
        "--quiet",
        "--force",
        "--backup-dir",
        join(sideways.root, "sideways", "..", "granted-throwaway", "kept-inside"),
      ]);
      assert.equal(viaDotDot.code, 64, JSON.stringify(viaDotDot.result));
      assert.ok(existsSync(join(sideways.scaffold, "package.json")), "nothing was deleted");

      // And the sibling that merely starts the same way is STILL fine, for all
      // three of those: the test is "is it the same folder", not "does the
      // name look similar".
      const ok = await box();
      const fine = await uninstall(ok, ["--check", "--backup-dir", `${ok.installDir}-backup`]);
      assert.equal(fine.code, 0, JSON.stringify(fine.result));
      assert.equal(fine.result["backupDir"], `${ok.installDir}-backup`);
    });

    // REGRESSION (review, round 3): and the check that closes the question
    // whatever the spelling. The containment check above is a prediction about
    // which names mean the same place; this one asks the disk, after everything
    // has been deleted, whether the folder keptKeys names is actually there.
    //
    // The case here is not an alias at all, which is the point: the backup goes
    // into the SHARED settings folder, which this same run deletes as the last
    // install out. No containment check against the install folder could ever
    // catch that, and before this the run reported
    // {"removed":true,"keptKeys":"<that path>"} for a folder it had just
    // removed — exit 0, and the user sent to look for keys that are gone.
    test("a copy of the keys that was destroyed during the uninstall is reported as no copy, not as a path that's gone", async () => {
      const b = await box();
      const inside = join(b.supportDir, "kept");
      const { code, result } = await uninstall(b, ["--quiet", "--force", "--backup-dir", inside]);
      assert.equal(code, 0, JSON.stringify(result));
      assert.equal(result["removed"], true);
      assert.equal(existsSync(b.installDir), false, "the install really did go");
      assert.equal(existsSync(inside), false, "and so did the copy, with the settings folder it was in");
      assert.equal(result["keptKeys"], null, "so the answer claims no copy rather than naming one that isn't there");

      // The general rule, stated the other way round: whatever keptKeys names,
      // it exists.
      const good = await box();
      const fine = await uninstall(good, ["--quiet", "--backup-dir", good.backupDir]);
      assert.equal(fine.code, 0, JSON.stringify(fine.result));
      assert.equal(fine.result["keptKeys"], good.backupDir);
      assert.ok(existsSync(String(fine.result["keptKeys"])), "a keptKeys that is reported is a folder that is there");
    });

    // REGRESSION (review, round 3): bad input printed only to stderr. The app
    // starts this script detached and reads the one JSON line it writes to a
    // log file — it has no stderr to read — so an exit 64 with no JSON line
    // left the Uninstall panel sitting on "an uninstall was started" until the
    // staleness window elapsed, instead of saying what was wrong. Two of these
    // need no typed argument at all: GRANTED_UNINSTALL_BACKUP_DIR pointed
    // inside the install folder, and a GRANTED_PORT that isn't a number.
    test("every bad-input refusal prints a JSON line as well, so the app can read an answer", async () => {
      const b = await box();
      const cases: Array<{ args: string[]; env?: Record<string, string>; detail: RegExp }> = [
        { args: ["--port", "soon"], detail: /--port must be a number/ },
        { args: ["--no-such-option"], detail: /unknown option --no-such-option/ },
        { args: ["--quiet", "--backup-dir"], detail: /--backup-dir needs a value/ },
        { args: ["--quiet", "--force", "--backup-dir", join(b.installDir, "kept-inside")], detail: /outside the folder being deleted/ },
        // Through the environment, which is how the app reaches this at all:
        // it passes neither --backup-dir nor --port.
        { args: ["--quiet", "--force"], env: { GRANTED_UNINSTALL_BACKUP_DIR: join(b.scaffold, "kept") }, detail: /outside the folder being deleted/ },
      ];
      for (const c of cases) {
        const { code, result } = await uninstall(b, c.args, c.env ?? {});
        assert.equal(code, 64, `${c.args.join(" ")}: ${JSON.stringify(result)}`);
        assert.equal(result["removed"], false, `${c.args.join(" ")} says removed:false`);
        assert.equal(result["reason"], "bad-input", `${c.args.join(" ")} says why`);
        assert.match(String(result["detail"]), c.detail);
        assert.ok(existsSync(join(b.scaffold, "package.json")), `${c.args.join(" ")} deleted nothing`);
      }
      // And it is a line parseUninstallOutcome can read, which is the only
      // reason it is there.
      const { result } = await uninstall(b, ["--port", "soon"]);
      assert.equal(typeof result["removed"], "boolean");
    });

    // REGRESSION (review): the keys dialog's answer used to overwrite an
    // explicit --keep-keys/--no-keep-keys on every run that wasn't --quiet, so
    // `--confirmed --no-keep-keys` wrote the API keys to the backup folder
    // anyway whenever the dialog was answered "Keep a copy". Secrets written to
    // disk against an explicit instruction not to is the wrong way round for
    // that to fail.
    test("an explicit --keep-keys / --no-keep-keys decides it, whatever the dialog is answered", async () => {
      // ask=no means "no" to "Delete your API keys with Granted?", i.e. keep a
      // copy — the opposite of what --no-keep-keys says.
      const none = await box({ ask: "no" });
      const without = await uninstall(none, ["--confirmed", "--no-keep-keys", "--backup-dir", none.backupDir]);
      assert.equal(without.code, 0, JSON.stringify(without.result));
      assert.equal(without.result["keptKeys"], null, "the flag was obeyed, not the dialog");
      assert.equal(existsSync(none.backupDir), false, "and no copy of the keys was written anywhere");
      assert.equal(existsSync(none.installDir), false);

      // And the other way round: ask=yes means "delete them", which --keep-keys
      // overrides just as explicitly.
      const kept = await box({ ask: "yes" });
      const withCopy = await uninstall(kept, ["--confirmed", "--keep-keys", "--backup-dir", kept.backupDir]);
      assert.equal(withCopy.code, 0, JSON.stringify(withCopy.result));
      assert.equal(withCopy.result["keptKeys"], kept.backupDir);
      assert.match(readFileSync(join(kept.backupDir, ".env.local"), "utf8"), /sk-uninstall-test/);
    });

    test("a copy of the keys that can't be made stops the uninstall before anything is deleted (exit 1)", async () => {
      const b = await box();
      const { code, result } = await uninstall(b, ["--quiet", "--backup-dir", "/no-such-root-for-a-test/backup"]);
      assert.equal(code, 1);
      assert.equal(result["reason"], "error");
      assert.ok(String(result["detail"]).length > 0);
      assert.ok(existsSync(join(b.scaffold, "package.json")), "it stopped before deleting anything");
    });

    test("the whole thing: a running server, a LaunchAgent, a launcher, a Dock tile, settings and logs — all gone", async () => {
      const b = await box();
      // A real background Granted, exactly as the installer starts it.
      await execFileAsync("/bin/bash", [b.trayScript, "start", "--port", String(PORT)], {
        env: { ...process.env, ...b.env },
        timeout: 180_000,
      });
      assert.equal(await until(() => probeGranted(`http://127.0.0.1:${PORT}/`, 3000), (p) => p === "granted"), "granted");
      assert.ok(b.agentLoaded(), "the throwaway LaunchAgent is loaded");
      assert.ok(existsSync(b.plistPath), "and its plist is written");
      // A real launcher, in its own Applications folder and its own "Dock".
      await execFileAsync("/bin/bash", [b.launcherScript, "install", "--port", String(PORT), "--add-to-dock"], {
        env: { ...process.env, ...b.env },
        timeout: 120_000,
      });
      assert.ok(existsSync(b.appPath));
      assert.ok(dockPlist(b).includes(b.appPath), "the tile is in the throwaway Dock");
      const check = (await uninstall(b, ["--check"])).result;
      assert.equal(check["launchAgent"], "own");
      assert.equal(check["launcher"], "own");

      const { code, result } = await uninstall(b, ["--quiet", "--backup-dir", b.backupDir]);
      assert.equal(code, 0, JSON.stringify(result));
      assert.equal(result["removed"], true);
      assert.equal(result["leftover"] ?? null, null);
      assert.equal(result["removedLaunchAgent"], true);
      assert.equal(result["removedLauncher"], true);
      assert.equal(result["removedFromDock"], true);
      assert.equal(result["removedSettings"], true);
      assert.equal(result["removedLogs"], true);

      // The folder, including the moved-aside copy.
      assert.equal(existsSync(b.installDir), false);
      assert.equal(
        execFileSync("/bin/ls", ["-A", b.root], { encoding: "utf8" })
          .split("\n")
          .some((name) => name.includes(".uninstalling-")),
        false,
        "nothing left behind beside it",
      );
      // The server and its LaunchAgent.
      assert.equal(await probeGranted(`http://127.0.0.1:${PORT}/`, 2000), "down", "the background server was stopped");
      assert.equal(b.agentLoaded(), false, "and the agent was booted out");
      assert.equal(existsSync(b.plistPath), false, "and its plist removed");
      // The launcher, its Dock tile, the settings and the logs.
      assert.equal(existsSync(b.appPath), false);
      assert.ok(!dockPlist(b).includes(b.appPath), "the Dock tile is gone");
      assert.equal(existsSync(b.supportDir), false, "settings");
      assert.equal(existsSync(b.logDir), false, "logs");
      // And the keys were kept, outside all of it.
      assert.equal(result["keptKeys"], b.backupDir);
      assert.match(readFileSync(join(b.backupDir, ".env.local"), "utf8"), /sk-uninstall-test/);
    });

    test("a `npm run dev` left running in a terminal is stopped too, and an unrelated node process isn't", async () => {
      const b = await box();
      // Node running from inside the install, the way a developer's own
      // `npm run dev` would be: not under the LaunchAgent, but still holding
      // the folder.
      const inside = spawn(process.execPath, [join(b.scaffold, "fake-dev.js")], {
        cwd: b.scaffold,
        env: { ...process.env, PORT: String(PORT) },
        stdio: "ignore",
      });
      started.push(inside);
      assert.equal(await until(() => probeGranted(`http://127.0.0.1:${PORT}/`, 2000), (p) => p === "granted"), "granted");
      // And an unrelated node, in a SIBLING folder whose name starts with the
      // install's: it must survive.
      const sibling = `${b.installDir}-dev`;
      mkdirSync(sibling, { recursive: true });
      writeFileSync(join(sibling, "server.js"), "setInterval(() => {}, 1000);", "utf8");
      const other = spawn(process.execPath, [join(sibling, "server.js")], { cwd: sibling, stdio: "ignore" });
      started.push(other);
      await sleep(500);

      const { code, result } = await uninstall(b, ["--quiet", "--no-keep-keys"]);
      assert.equal(code, 0, JSON.stringify(result));
      assert.equal(await probeGranted(`http://127.0.0.1:${PORT}/`, 2000), "down", "the server in the folder was stopped");
      assert.equal(other.exitCode, null, "the unrelated node in a sibling folder is still running");
      other.kill();
      assert.equal(existsSync(b.installDir), false);
    });

    test("a file still in use: the folder goes anyway (POSIX, unlike Windows), and the uninstall says so plainly", async () => {
      const b = await box();
      // An open descriptor on a file inside, and a process whose working
      // directory is in there. On Windows either one would fail the move and
      // nothing would be deleted; on macOS a rename and an unlink both succeed
      // — which is why the move-aside step is about atomicity here, not about
      // files in use (see uninstall.sh's header).
      const held = openSync(join(b.scaffold, ".env.local"), "r");
      const sitting = spawn("/bin/sh", ["-c", "while :; do sleep 1; done"], { cwd: join(b.scaffold, "scripts"), stdio: "ignore" });
      started.push(sitting);
      await sleep(300);
      try {
        const { code, result } = await uninstall(b, ["--quiet", "--no-keep-keys"]);
        assert.equal(code, 0, JSON.stringify(result));
        assert.equal(result["removed"], true);
        assert.equal(existsSync(b.installDir), false);
      } finally {
        closeSync(held);
        sitting.kill();
      }
    });

    test("a folder that can't be moved: exit 3, and NOTHING else was touched, so it can be retried", async () => {
      const b = await box();
      // The launcher, the Dock tile and the settings are all in place first, so
      // "nothing else was touched" means something.
      await execFileAsync("/bin/bash", [b.launcherScript, "install", "--port", String(PORT), "--add-to-dock"], {
        env: { ...process.env, ...b.env },
        timeout: 120_000,
      });
      assert.ok(existsSync(b.appPath));
      // A rename needs write permission on the PARENT folder; without it the
      // move fails and the script must stop there.
      chmodSync(b.root, 0o555);
      try {
        const { code, result } = await uninstall(b, ["--quiet", "--backup-dir", join(b.applicationsDir, "kept")]);
        assert.equal(code, 3, JSON.stringify(result));
        // Permission, not a file in use: on macOS those are the two ways a
        // move can fail, and the script tells them apart because what the user
        // has to do about them differs.
        assert.equal(result["reason"], "access-denied");
        assert.match(String(result["detail"]), /Permission denied/, "and what the move actually said");
        // Still a whole, retryable install.
        assert.ok(existsSync(join(b.scaffold, "package.json")));
        assert.ok(existsSync(join(b.scaffold, ".env.local")));
        assert.ok(existsSync(b.appPath), "the launcher is still there");
        assert.ok(dockPlist(b).includes(b.appPath), "and so is its Dock tile");
        assert.ok(existsSync(join(b.supportDir, "settings.json")), "and the settings");
        assert.ok(existsSync(b.logDir), "and the logs");
      } finally {
        chmodSync(b.root, 0o755);
      }
      // Once it can be moved, uninstalling again works.
      const retry = await uninstall(b, ["--quiet", "--no-keep-keys"]);
      assert.equal(retry.code, 0, JSON.stringify(retry.result));
      assert.equal(existsSync(b.installDir), false);
      assert.equal(existsSync(b.appPath), false);
      assert.ok(!dockPlist(b).includes(b.appPath));
    });

    // The other half of the exit-3 case, as the app sees it. Settings → About
    // Granted is answered "started" as soon as the script is running, which is
    // before the script has decided anything; what the page then polls for is
    // this line in the log, and a refusal has to be IN there for the page to
    // have anything to recover from (scaffold/lib/appUpdate/install.ts's
    // parseUninstallOutcome reads exactly this line).
    test("an uninstaller that refuses after it was started says so in its log, which is what the app reads", async () => {
      const b = await box({ ask: "yes" });
      // Outside the folder that is about to be made unwritable.
      const log = join(root, `refused-${randomUUID()}.log`);
      chmodSync(b.root, 0o555);
      try {
        const { stdout } = await execFileAsync("/bin/bash", [b.trayScript, "uninstall", "--port", String(PORT)], {
          env: { ...process.env, ...b.env, GRANTED_UNINSTALL_LOG: log },
          timeout: 60_000,
        });
        const answer = JSON.parse(stdout.trim().split("\n").pop() as string) as { started?: boolean; log?: string };
        assert.equal(answer.started, true, "the caller is told it started, which is all it can know");
        assert.equal(answer.log, log);
        const written = await until(
          async () => (existsSync(log) ? readFileSync(log, "utf8") : ""),
          (text) => /"removed"/.test(text),
          60_000,
        );
        const outcome = JSON.parse(written.trim().split(/\r?\n/).filter(Boolean).pop() as string) as Record<string, unknown>;
        assert.equal(outcome["removed"], false, "and it then refused, in the log the app polls");
        assert.equal(outcome["reason"], "access-denied");
        assert.ok(existsSync(join(b.scaffold, "package.json")), "with the install whole and Granted still installed");
      } finally {
        chmodSync(b.root, 0o755);
      }
    });

    test("another Granted's LaunchAgent and launcher are left alone, and the shared settings go with the last install out", async () => {
      const first = await box();
      const second = await box({ sharedWith: first });
      // The launcher and the LaunchAgent in place both belong to the SECOND
      // install, and sit where the first one's would. (A real second install
      // would also use the same label, so the plist really would be at the
      // path the first one looks at; the labels here are per-box so that no
      // test can touch another's, which is why its content is put there by
      // hand.)
      await execFileAsync("/bin/bash", [second.launcherScript, "install", "--port", String(PORT), "--add-to-dock"], {
        env: { ...process.env, ...second.env },
        timeout: 120_000,
      });
      const foreignPlist = execFileSync("/bin/bash", [second.trayScript, "plist", "--port", String(PORT)], {
        encoding: "utf8",
        env: { ...process.env, ...second.env },
      });
      assert.match(foreignPlist, new RegExp(second.scaffold.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      await writeFile(first.plistPath, foreignPlist, "utf8");

      const check = (await uninstall(first, ["--check"])).result;
      assert.equal(check["launchAgent"], "other", "that plist is another install's");
      assert.equal(check["launcher"], "other", "and so is that launcher");

      const { code, result } = await uninstall(first, ["--quiet", "--no-keep-keys"]);
      assert.equal(code, 0, JSON.stringify(result));
      assert.equal(existsSync(first.installDir), false, "this install is gone");
      assert.equal(result["removedLaunchAgent"], false);
      assert.equal(result["removedLauncher"], false);
      assert.equal(result["removedSettings"], false);
      assert.equal(result["removedLogs"], false);
      assert.ok(existsSync(first.plistPath), "the LaunchAgent that belongs to another install stays");
      assert.ok(existsSync(second.appPath), "and its launcher");
      assert.ok(dockPlist(second).includes(second.appPath), "and its Dock tile");
      assert.ok(existsSync(join(first.supportDir, "settings.json")), "and the shared settings");
      assert.ok(existsSync(first.logDir), "and the shared logs");

      // Now the last one out: the shared files go with it.
      const last = await uninstall(second, ["--quiet", "--no-keep-keys"]);
      assert.equal(last.code, 0, JSON.stringify(last.result));
      assert.equal(last.result["removedLauncher"], true);
      assert.equal(last.result["removedSettings"], true);
      assert.equal(last.result["removedLogs"], true);
      assert.equal(existsSync(second.supportDir), false);
      assert.equal(existsSync(second.logDir), false);
      assert.equal(existsSync(second.appPath), false);
    });

    test("bad input is a usage error (64), and nothing is deleted", async () => {
      const b = await box();
      for (const args of [["--port", "abc"], ["--port"], ["--nope"], ["--install-dir"]]) {
        const { code } = await uninstall(b, args);
        assert.equal(code, 64, `${args.join(" ")} is a usage error`);
      }
      assert.ok(existsSync(join(b.scaffold, "package.json")));
    });

    test("a path with a space and an apostrophe in it uninstalls like any other", async () => {
      // No --install-dir: the script works out which install it is in from its
      // own location, which is the awkward path here.
      const b = await box({ name: "Jo's Granted folder" });
      const { code, result } = await uninstall(b, ["--quiet", "--backup-dir", join(b.root, "kept for Jo's keys")]);
      assert.equal(code, 0, JSON.stringify(result));
      assert.equal(result["installDir"], b.installDir);
      assert.equal(existsSync(b.installDir), false);
      assert.match(readFileSync(join(b.root, "kept for Jo's keys", ".env.local"), "utf8"), /sk-uninstall-test/);
    });

    test("granted-tray.sh uninstall really starts it, detached, and it finishes the job", async () => {
      const b = await box({ ask: "yes" });
      const log = join(b.root, "uninstall.log");
      const { stdout } = await execFileAsync("/bin/bash", [b.trayScript, "uninstall", "--port", String(PORT)], {
        env: { ...process.env, ...b.env, GRANTED_UNINSTALL_LOG: log },
        timeout: 60_000,
      });
      const answer = JSON.parse(stdout.trim().split("\n").pop() as string) as { started?: boolean; log?: string };
      assert.equal(answer.started, true);
      assert.equal(answer.log, log);
      // It returned at once; the uninstall itself runs on.
      assert.equal(
        await until(async () => existsSync(b.installDir), (there) => !there, 120_000),
        false,
        "the install was removed by the detached uninstaller",
      );
      assert.match(readFileSync(log, "utf8"), /"removed":true/, "and it reported what it did in its own log");
      // An install too old to have the script says so rather than pretending.
      const old = await box();
      await rm(old.uninstallScript, { force: true });
      await assert.rejects(
        () => execFileAsync("/bin/bash", [old.trayScript, "uninstall", "--port", String(PORT)], { env: { ...process.env, ...old.env } }),
        (err: { stdout?: string }) => /no-uninstaller/.test(err.stdout ?? ""),
      );
    });
  },
);

// --- the menu-bar item (macOS, Swift, a GUI session) ------------------------

describe(
  "the menu-bar helper's Uninstall item, chosen for real",
  {
    skip:
      (process.platform !== "darwin" || !existsSync(MENUBAR_PKG) || !hasSwift() || !inAquaSession()) &&
      "macOS with the Xcode Command Line Tools and a GUI session only, run from installer/",
  },
  () => {
    let root: string;
    const boxes: Box[] = [];

    const helperBinary = (): string => join(MENUBAR_PKG, ".build", "release", "granted-menubar");

    /** Chooses the item the way a click does (see the helper's GRANTED_MENUBAR_SELF_TEST). */
    const click = async (b: Box, confirm: "yes" | "no", log: string): Promise<string> => {
      const { stdout } = await execFileAsync(helperBinary(), [], {
        env: {
          ...process.env,
          ...b.env,
          GRANTED_PORT: String(PORT),
          GRANTED_TRAY_SCRIPT: b.trayScript,
          GRANTED_LOG_FILE: join(b.logDir, `server-${PORT}.log`),
          GRANTED_MENUBAR_CONFIRM: confirm,
          GRANTED_UNINSTALL_LOG: log,
          GRANTED_MENUBAR_SELF_TEST: "click:Uninstall Granted…",
        },
        timeout: 4 * 60_000,
      });
      assert.match(stdout, /clicking "Uninstall Granted…"/);
      assert.match(stdout, /"Uninstall Granted…" done/);
      return stdout;
    };

    before(async () => {
      root = realpathSync(await mkdtemp(join(tmpdir(), "granted-mac-uninstall-menu-it-")));
      await execFileAsync("swift", ["build", "-c", "release", "--package-path", MENUBAR_PKG], { timeout: 10 * 60_000 });
    });

    after(async () => {
      for (const b of boxes) {
        try {
          execFileSync("launchctl", ["bootout", `gui/${process.getuid?.() ?? 0}/${b.label}`], { stdio: "ignore" });
        } catch {
          /* already gone */
        }
      }
      await rm(root, { recursive: true, force: true, maxRetries: 5 });
    });

    test("Cancel deletes nothing at all", async () => {
      const b = await makeBox(root, { ask: "yes" });
      boxes.push(b);
      const log = join(b.root, "never.log");
      await click(b, "no", log);
      await sleep(1000);
      assert.ok(existsSync(join(b.scaffold, "package.json")), "the install is untouched");
      assert.equal(existsSync(log), false, "and the uninstaller was never started");
    });

    test("Uninstall starts the real uninstaller, which removes the install", async () => {
      const b = await makeBox(root, { ask: "yes" });
      boxes.push(b);
      const log = join(b.root, "uninstall.log");
      await click(b, "yes", log);
      assert.equal(
        await until(async () => existsSync(b.installDir), (there) => !there, 120_000),
        false,
      );
      assert.match(readFileSync(log, "utf8"), /"removed":true/);
    });
  },
);
