/**
 * Integration: the REAL scaffold/scripts/macos/granted-tray.sh and the REAL
 * Swift menu-bar helper — Granted running in the background on macOS — against
 * a fake Granted install whose `npm run dev` is a tiny Node server, so this
 * proves the whole LaunchAgent lifecycle (write the plist, bootstrap,
 * kickstart, stop, bootout), the hidden server, the log location and the
 * status reporting without a real Next.js build. The macOS counterpart of
 * tray.integration.test.ts.
 *
 * Everything here runs against a THROWAWAY LaunchAgent label
 * (com.granted.test.<uuid>, via GRANTED_LAUNCH_LABEL) whose plist is written
 * into a temp folder (GRANTED_LAUNCH_AGENTS_DIR), never ~/Library/LaunchAgents
 * and never the real com.granted.server — this must not be able to touch a
 * real Granted install, or leave anything registered on the machine running
 * the tests. The teardown boots the label out directly as well as through the
 * script, and the last test asserts it is gone.
 *
 * macOS only for the launchctl parts; the two file-shape checks run anywhere
 * (they are what keeps the script, the helper and the app's own status
 * mechanism from drifting apart).
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { macStatusLockPath, macTrayLaunchCommand } from "../ipcPure";
import { probeGranted, readStatusFile, readTaskStatus } from "../openGranted";

const execFileAsync = promisify(execFile);

// `npm test` runs from installer/; the scripts live in scaffold/.
const MACOS_SCRIPTS = resolve(process.cwd(), "..", "scaffold", "scripts", "macos");
const TRAY_SCRIPT = join(MACOS_SCRIPTS, "granted-tray.sh");
const MENUBAR_PKG = join(MACOS_SCRIPTS, "menubar");
const HELPER_SOURCE = join(MENUBAR_PKG, "Sources", "GrantedMenuBar", "main.swift");
const GRANTED_HTML = "<title>Granted — federal funding intelligence for everyone</title>";
const PORT = 3977;

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

/** The release binary granted-tray.sh runs (and CI builds). */
function helperBinary(): string {
  return join(MENUBAR_PKG, ".build", "release", "granted-menubar");
}

/** Whether this process is in a GUI (Aqua) session, which NSStatusBar needs. */
function inAquaSession(): boolean {
  try {
    return execFileSync("launchctl", ["managername"], { encoding: "utf8" }).trim() === "Aqua";
  } catch {
    return false;
  }
}

interface FakeInstall {
  root: string;
  scaffold: string;
  /** The real granted-tray.sh, in the place a real install has it. */
  trayScript: string;
  /** A throwaway LaunchAgent label, never the real com.granted.server. */
  label: string;
  statusPath: string;
  /** The pid file granted-tray.sh's own start_helper writes. */
  helperPidFile: string;
  /** The test-only overrides to run the script (or the helper) with. */
  env: Record<string, string>;
  agentLoaded: () => boolean;
  cleanup: () => Promise<void>;
}

interface FakeInstallOptions {
  /**
   * The menu-bar helper granted-tray.sh should run. "none" (the default) means
   * no icon at all: a test must not leave one on anyone's menu bar unless it
   * is specifically testing the helper, and then only for its own duration.
   */
  helper?: string;
  /**
   * How long the fake server takes to exit after SIGTERM, in milliseconds.
   * Zero (the default) means it exits at once, as a normal server does.
   */
  stopDelayMs?: number;
}

/**
 * A fake Granted install whose `npm run dev` is a tiny Node server, with the
 * real tray script in it, pointed entirely at throwaway paths and a throwaway
 * LaunchAgent label. `cleanup` stops anything running, kills any menu-bar
 * helper this install started, boots the label out directly as well (whatever
 * state the test left), and deletes the folder.
 */
async function setUpFakeInstall(options: FakeInstallOptions = {}): Promise<FakeInstall> {
  // realpath: mkdtemp hands back /var/folders/..., a symlink to
  // /private/var/folders/..., and the script resolves its own location with
  // `pwd -P` — so the paths in the plist are the resolved ones.
  const root = realpathSync(await mkdtemp(join(tmpdir(), "granted-mac-tray-it-")));
  const scaffold = join(root, "granted", "scaffold");
  mkdirSync(join(scaffold, "scripts", "macos"), { recursive: true });
  mkdirSync(join(root, "LaunchAgents"), { recursive: true });
  const trayScript = join(scaffold, "scripts", "macos", "granted-tray.sh");
  await writeFile(trayScript, readFileSync(TRAY_SCRIPT, "utf8"), "utf8");
  await writeFile(
    join(scaffold, "package.json"),
    JSON.stringify({ name: "fake-granted", private: true, scripts: { dev: "node fake-dev.js" } }),
    "utf8",
  );
  await writeFile(
    join(scaffold, "fake-dev.js"),
    [
      "const port = Number(process.env.PORT);",
      'if (!port) { console.error("fake dev server: PORT not set"); process.exit(1); }',
      // A file, not an environment variable: the LaunchAgent plist carries
      // only PATH/PORT/HOME (deliberately), so nothing the test's own env
      // says reaches a launchd-started server.
      'if (require("node:fs").existsSync(__dirname + "/fail")) { console.error("fake dev server: failing on purpose"); process.exit(1); }',
      // A server that is slow to shut down, for the same reason and by the
      // same mechanism: a real `next dev` does not drop dead the instant it is
      // signalled either.
      `const stopDelayMs = ${JSON.stringify(options.stopDelayMs ?? 0)};`,
      "if (stopDelayMs > 0) {",
      '  process.on("SIGTERM", () => { console.log("fake dev server: exiting in " + stopDelayMs + "ms"); setTimeout(() => process.exit(0), stopDelayMs); });',
      "}",
      'require("node:http")',
      `  .createServer((_req, res) => { res.writeHead(200, { "Content-Type": "text/html" }); res.end(${JSON.stringify(GRANTED_HTML)}); })`,
      '  .listen(port, "127.0.0.1", () => console.log("fake Granted listening on 127.0.0.1:" + port));',
    ].join("\n"),
    "utf8",
  );
  const label = `com.granted.test.${randomUUID()}`;
  const statusPath = join(root, "status.json");
  // Where granted-tray.sh's HELPER_PID_FILE lands: next to the settings file,
  // named for the port.
  const helperPidFile = join(root, "support", `menubar-${PORT}.pid`);
  const domain = `gui/${process.getuid?.() ?? 0}/${label}`;
  const env = {
    GRANTED_LAUNCH_LABEL: label,
    GRANTED_LAUNCH_AGENTS_DIR: join(root, "LaunchAgents"),
    GRANTED_LOG_DIR: join(root, "logs"),
    GRANTED_SETTINGS_PATH: join(root, "support", "settings.json"),
    GRANTED_STATUS_FILE: statusPath,
    // No menu-bar icon unless a test asks for one by running the helper
    // itself: a test must not leave an icon on anyone's menu bar.
    GRANTED_MENUBAR_HELPER: options.helper ?? "none",
  };
  const agentLoaded = (): boolean => {
    try {
      execFileSync("launchctl", ["print", domain], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  };
  return {
    root,
    scaffold,
    trayScript,
    label,
    statusPath,
    helperPidFile,
    env,
    agentLoaded,
    cleanup: async () => {
      try {
        execFileSync("/bin/bash", [trayScript, "stop", "--port", String(PORT)], { stdio: "ignore", env: { ...process.env, ...env } });
      } catch {
        /* nothing was running */
      }
      // Belt and braces: whatever the test did or didn't manage, this label
      // must not be left registered on the machine — and no menu-bar helper
      // this install started may be left on the menu bar either.
      if (existsSync(helperPidFile)) {
        const pid = Number(readFileSync(helperPidFile, "utf8").trim());
        if (Number.isInteger(pid) && pid > 0) {
          try {
            process.kill(pid, "SIGKILL");
          } catch {
            /* already gone */
          }
        }
      }
      try {
        execFileSync("launchctl", ["bootout", domain], { stdio: "ignore" });
      } catch {
        /* already gone */
      }
      await rm(root, { recursive: true, force: true, maxRetries: 5 });
    },
  };
}

// --- file-shape checks (any platform) --------------------------------------

test(
  "granted-tray.sh's LaunchAgent is never a login item: RunAtLoad false, no KeepAlive",
  { skip: !existsSync(TRAY_SCRIPT) && "run from installer/" },
  () => {
    const script = readFileSync(TRAY_SCRIPT, "utf8");
    // The plist template must say RunAtLoad false. With it true, launchd would
    // start Granted every time the plist is loaded — which happens at every
    // login, since it lives in ~/Library/LaunchAgents. The whole point of
    // bootstrap-then-kickstart is that only opening Granted starts it.
    assert.match(script, /<key>RunAtLoad<\/key>\s*\n\s*<false\/>/, "RunAtLoad must be false in the plist template");
    assert.ok(!script.includes("<key>KeepAlive</key>"), "no KeepAlive: launchd must not start or revive Granted on its own");
    assert.match(script, /launchctl bootstrap/, "the agent is loaded on demand");
    assert.match(script, /launchctl bootout/, "and unloaded again on quit");
  },
);

test(
  "the menu-bar helper reports through the app's own status mechanism, with every menu item labelled for VoiceOver",
  { skip: !existsSync(HELPER_SOURCE) && "run from installer/" },
  () => {
    const source = readFileSync(HELPER_SOURCE, "utf8");
    // The same lock directory suffix the app's isStatusWindowAlive looks for:
    // if these two ever drift, a live menu-bar icon reads as a closed window.
    assert.ok(source.includes('"\\($0).lock.d"'), "the helper must take exactly the <status>.lock.d directory");
    assert.equal(macStatusLockPath("/tmp/x.json"), "/tmp/x.json.lock.d");
    assert.match(source, /"pid": ProcessInfo\.processInfo\.processIdentifier/, "and write its pid, as the task scripts do");
    // The Windows tray's menu, item for item.
    for (const title of ["Open Granted", "Open in its own window", "Show log", "Restart", "Quit Granted"]) {
      assert.ok(source.includes(`title: "${title}"`), `the menu must have "${title}", like the Windows tray`);
    }
    assert.match(source, /func describe\([\s\S]*?setAccessibilityLabel[\s\S]*?setAccessibilityHelp/, "a real VoiceOver label and help");
    // Six describe()d items: the five above plus the status line.
    assert.ok((source.match(/^\s*describe\(/gm) ?? []).length >= 6, "every menu item is described, not just some");
  },
);

// --- the real thing (macOS) ------------------------------------------------

describe(
  "granted-tray.sh, run for real against a throwaway LaunchAgent label",
  { skip: (process.platform !== "darwin" || !existsSync(TRAY_SCRIPT)) && "macOS only, run from installer/" },
  () => {
    let fake: FakeInstall;
    let root: string;
    let scaffold: string;
    let trayScript: string;
    let label: string;
    let env: Record<string, string>;
    let statusPath: string;

    const tray = (...args: string[]): Promise<{ stdout: string; stderr: string }> =>
      execFileAsync("/bin/bash", [trayScript, ...args, "--port", String(PORT)], { env: { ...process.env, ...env }, timeout: 180_000 });

    const agentLoaded = (): boolean => fake.agentLoaded();

    before(async () => {
      fake = await setUpFakeInstall();
      ({ root, scaffold, trayScript, label, env, statusPath } = fake);
    });

    after(async () => {
      await fake.cleanup();
    });

    test("the plist it writes runs this install's npm in this scaffold, with the port and a log in the log folder", async () => {
      const { stdout } = await execFileAsync("/bin/bash", [trayScript, "plist", "--port", String(PORT)], {
        env: { ...process.env, ...env, GRANTED_NPM: "/usr/local/bin/npm" },
      });
      assert.match(stdout, new RegExp(`<key>Label</key>\\s*\\n\\s*<string>${label}</string>`));
      assert.match(stdout, /<string>\/usr\/local\/bin\/npm<\/string>\s*\n\s*<string>run<\/string>\s*\n\s*<string>dev<\/string>/);
      assert.ok(stdout.includes(`<string>${scaffold}</string>`), "WorkingDirectory is this install's scaffold folder");
      assert.ok(stdout.includes(`<string>${join(root, "logs", `server-${PORT}.log`)}</string>`), "stdout and stderr go to the server log");
      assert.match(stdout, /<key>PORT<\/key>\s*\n\s*<string>3977<\/string>/);
      // launchd's own PATH (/usr/bin:/bin:/usr/sbin:/sbin) has no Homebrew in
      // it, so the plist must carry a real one or `npm run dev` can't find node.
      assert.match(stdout, /<key>PATH<\/key>/);
      // And it must be valid plist XML as far as the system is concerned.
      const plist = join(root, "check.plist");
      await writeFile(plist, stdout, "utf8");
      await execFileAsync("/usr/bin/plutil", ["-lint", plist]);
    });

    test("start: the server runs hidden under the LaunchAgent, answers on the port, and logs to ~/Library/Logs/Granted's stand-in", async () => {
      await tray("start");
      assert.ok(agentLoaded(), "the agent is loaded");
      assert.equal(await until(() => probeGranted(`http://127.0.0.1:${PORT}/`, 3000), (p) => p === "granted"), "granted");
      // Hidden: nothing of this is attached to a terminal — it is launchd's
      // child, with its output in the log file.
      const { stdout } = await tray("status");
      assert.equal((JSON.parse(stdout.trim()) as { state: string }).state, "running");
      const log = join(root, "logs", `server-${PORT}.log`);
      assert.ok(existsSync(log), "the server log is in the log folder");
      assert.match(readFileSync(log, "utf8"), /fake Granted listening/);
      // The status file the installer polls says "running" — with no pid,
      // since no menu-bar helper is holding the lock in this test (so
      // liveness is never asked about, see resolveTaskStatus).
      const status = await readStatusFile(statusPath);
      assert.equal(status?.state, "running");
      assert.equal(status?.pid, undefined);
    });

    test("start again, with Granted already up: it doesn't start a second server", async () => {
      const before = (await tray("status")).stdout;
      await tray("start");
      assert.equal(await probeGranted(`http://127.0.0.1:${PORT}/`, 3000), "granted");
      assert.equal((JSON.parse(before.trim()) as { state: string }).state, "running");
      // One launchd job, one run: `start` found Granted answering and left it alone.
      const printed = execFileSync("launchctl", ["print", `gui/${process.getuid?.() ?? 0}/${label}`], { encoding: "utf8" });
      assert.match(printed, /^\truns = 1$/m, "still the one server launchd started the first time");
    });

    test("restart: the same agent serves again on the same port", async () => {
      await tray("restart");
      assert.equal(await until(() => probeGranted(`http://127.0.0.1:${PORT}/`, 3000), (p) => p === "granted"), "granted");
      assert.ok(agentLoaded());
    });

    test("stop: the server is gone, the port is free, and nothing is left registered with launchd", async () => {
      await tray("stop");
      assert.equal(await probeGranted(`http://127.0.0.1:${PORT}/`, 3000), "down");
      assert.equal(agentLoaded(), false, "the agent is booted out, not just stopped");
      const { stdout } = await tray("status");
      assert.equal((JSON.parse(stdout.trim()) as { state: string }).state, "stopped");
    });

    test("stop with nothing running exits non-zero (like the Windows tray's -Stop), and stays harmless", async () => {
      await assert.rejects(() => tray("stop"));
      assert.equal(agentLoaded(), false);
    });

    test("a server that dies at once is reported as crashed, with the reason in the log", async () => {
      await writeFile(join(scaffold, "fail"), "", "utf8");
      try {
        await tray("start");
        const state = await until(
          async () => (JSON.parse((await tray("status")).stdout.trim()) as { state: string }).state,
          (s) => s === "crashed",
          30_000,
        );
        assert.equal(state, "crashed");
        assert.match(readFileSync(join(root, "logs", `server-${PORT}.log`), "utf8"), /failing on purpose/);
      } finally {
        rmSync(join(scaffold, "fail"), { force: true });
        await tray("stop").catch(() => undefined);
      }
    });

    test("macTrayLaunchCommand's arguments are what the script actually accepts", async () => {
      const { file, args } = macTrayLaunchCommand({ trayScript, port: PORT, statusPath });
      // Run exactly what ipc.ts's launchMacTray runs, then stop it again.
      await execFileAsync(file, args, { env: { ...process.env, ...env }, timeout: 180_000 });
      assert.equal(await until(() => probeGranted(`http://127.0.0.1:${PORT}/`, 3000), (p) => p === "granted"), "granted");
      assert.equal((await readStatusFile(statusPath))?.state, "running");
      await tray("stop");
      assert.equal(agentLoaded(), false);
    });
  },
);

describe(
  "the Swift menu-bar helper, built and run for real",
  {
    skip:
      (process.platform !== "darwin" || !existsSync(MENUBAR_PKG) || !hasSwift()) &&
      "macOS with the Xcode Command Line Tools only, run from installer/",
  },
  () => {
    let root: string;

    before(async () => {
      root = await mkdtemp(join(tmpdir(), "granted-menubar-it-"));
      // The real build, exactly as granted-tray.sh and CI run it. Release
      // mode so this is the very binary that ships, and so the build is
      // shared with the tray script's own first-run build.
      await execFileAsync("swift", ["build", "-c", "release", "--package-path", MENUBAR_PKG], { timeout: 10 * 60_000 });
    });

    after(async () => {
      await rm(root, { recursive: true, force: true, maxRetries: 5 });
    });

    test("swift build produces the binary granted-tray.sh looks for", async () => {
      const { stdout } = await execFileAsync("swift", ["build", "-c", "release", "--package-path", MENUBAR_PKG, "--show-bin-path"]);
      const binary = join(stdout.trim(), "granted-menubar");
      assert.ok(existsSync(binary), `${binary} must exist (granted-tray.sh runs .build/release/granted-menubar)`);
      // arm64/x86_64 native, not a script or a wrapper.
      const { stdout: fileType } = await execFileAsync("/usr/bin/file", ["-b", binary]);
      assert.match(fileType, /Mach-O 64-bit executable/);
    });

    test(
      "every menu item is enabled or disabled as it should be, and carries a VoiceOver label",
      { skip: !inAquaSession() && "needs a GUI (Aqua) session for NSStatusBar" },
      async () => {
        const { stdout } = await execFileAsync(helperBinary(), [], {
          env: { ...process.env, GRANTED_MENUBAR_SELF_TEST: "1", GRANTED_PORT: String(PORT), GRANTED_TRAY_SCRIPT: TRAY_SCRIPT },
          timeout: 60_000,
        });
        // REGRESSION (found on real hardware): with granted.ico as its
        // template image the status item was created, 34 points wide, and
        // drew NOTHING — an invisible menu bar extra. It must always end up
        // with an image or, failing that, a title.
        const icon = /icon=(none|yes) title="(.*)" width=([\d.]+)/.exec(stdout);
        assert.ok(icon, "the self test reports what the status item ended up showing");
        assert.ok(icon[1] === "yes" || icon[2].length > 0, "an image, or a title — never neither");
        assert.ok(Number(icon[3]) > 0, "and a real width");
        const items = [...stdout.matchAll(/item "(.+?)" enabled=(true|false) a11y="(.*)"/g)].map((m) => ({
          title: m[1],
          enabled: m[2] === "true",
          a11y: m[3],
        }));
        assert.deepEqual(
          items.map((i) => i.title),
          ["Open Granted", "Starting…", "Open in its own window", "Show log", "Restart", "Quit Granted"],
          "the Windows tray's menu, item for item",
        );
        for (const item of items) assert.ok(item.a11y.length > 0, `"${item.title}" must have a VoiceOver label`);
        // The status line is a label, not a command; "its own window" is
        // deliberately shown-but-disabled until that feature lands on macOS.
        assert.deepEqual(
          items.filter((i) => !i.enabled).map((i) => i.title),
          ["Starting…", "Open in its own window"],
        );
      },
    );

    test(
      "it starts, builds the whole menu, takes the status lock and writes its status — then leaves nothing behind",
      { skip: !inAquaSession() && "needs a GUI (Aqua) session for NSStatusBar" },
      async () => {
        const statusPath = join(root, "status.json");
        const { stdout } = await execFileAsync(helperBinary(), [], {
          env: {
            ...process.env,
            GRANTED_MENUBAR_SELF_TEST: "1",
            GRANTED_PORT: String(PORT),
            GRANTED_STATUS_FILE: statusPath,
            GRANTED_TRAY_SCRIPT: TRAY_SCRIPT,
            GRANTED_LOG_FILE: join(root, "server.log"),
          },
          timeout: 60_000,
        });
        // Open Granted, status, Open in its own window, separator, Show log,
        // Restart, separator, Quit Granted.
        assert.match(stdout, /self test ok \(port 3977, items: 8\)/);
        // It reported through the installer's own mechanism: the same
        // {state,message,pid} shape, read back by the app's own reader.
        const status = await readStatusFile(statusPath);
        assert.equal(status?.state, "running");
        assert.ok(status?.pid !== undefined && status.pid > 0, "with its own pid, like a task window");
        // And it released the lock on the way out, so the app reads it as gone
        // rather than as a live icon that vanished.
        assert.equal(existsSync(macStatusLockPath(statusPath)), false);
        assert.equal((await readTaskStatus(statusPath))?.state, "error", "a running status with no lock reads as closed");
      },
    );
  },
);

describe(
  "the menu-bar helper's menu items, chosen for real against a running Granted",
  {
    skip:
      (process.platform !== "darwin" || !existsSync(MENUBAR_PKG) || !hasSwift() || !inAquaSession()) &&
      "macOS with the Xcode Command Line Tools and a GUI session only, run from installer/",
  },
  () => {
    let fake: FakeInstall;
    /** What the menu asked the system to open (the GRANTED_OPEN_CMD stand-in's log). */
    let openedLog: string;
    let helperEnv: Record<string, string>;

    /**
     * Chooses one menu item the way a click does — the real NSMenuItem's real
     * action, sent to the real target by AppKit (see the helper's
     * GRANTED_MENUBAR_SELF_TEST) — and returns what it printed.
     */
    const click = async (title: string): Promise<string> => {
      const { stdout } = await execFileAsync(helperBinary(), [], {
        env: { ...process.env, ...helperEnv, GRANTED_MENUBAR_SELF_TEST: `click:${title}` },
        timeout: 4 * 60_000,
      });
      assert.match(stdout, new RegExp(`clicking "${title}"`));
      // Quit ends the process itself (NSApp.terminate), so it never reaches
      // the self test's "finished" line — exiting IS what it claims to do.
      if (title !== "Quit Granted") assert.match(stdout, new RegExp(`"${title}" done`));
      return stdout;
    };

    const opened = (): string[] =>
      existsSync(openedLog) ? readFileSync(openedLog, "utf8").split("\n").map((l) => l.trim()).filter(Boolean) : [];

    before(async () => {
      await execFileAsync("swift", ["build", "-c", "release", "--package-path", MENUBAR_PKG], { timeout: 10 * 60_000 });
      fake = await setUpFakeInstall();
      openedLog = join(fake.root, "opened.log");
      const openStandIn = join(fake.root, "fake-open.sh");
      await writeFile(openStandIn, `#!/bin/sh\nprintf '%s\\n' "$@" >> ${JSON.stringify(openedLog)}\n`, { mode: 0o755 });
      helperEnv = {
        ...fake.env,
        GRANTED_PORT: String(PORT),
        GRANTED_TRAY_SCRIPT: fake.trayScript,
        GRANTED_LOG_FILE: join(fake.root, "logs", `server-${PORT}.log`),
        GRANTED_HELPER_PID_FILE: join(fake.root, "menubar.pid"),
        // Never really open a browser or a log viewer from a test.
        GRANTED_OPEN_CMD: openStandIn,
      };
      // A real, running Granted for the menu to act on.
      await execFileAsync("/bin/bash", [fake.trayScript, "start", "--port", String(PORT)], {
        env: { ...process.env, ...fake.env },
        timeout: 180_000,
      });
      assert.equal(await until(() => probeGranted(`http://127.0.0.1:${PORT}/`, 3000), (p) => p === "granted"), "granted");
    });

    after(async () => {
      await fake.cleanup();
    });

    test("Open Granted opens Granted's URL", async () => {
      await click("Open Granted");
      assert.deepEqual(opened(), [`http://localhost:${PORT}`]);
    });

    test("Show log opens the server log for this port", async () => {
      await click("Show log");
      assert.equal(opened().at(-1), join(fake.root, "logs", `server-${PORT}.log`));
    });

    test("Restart stops the server and starts it again, on the same port", async () => {
      const printed = execFileSync("launchctl", ["print", `gui/${process.getuid?.() ?? 0}/${fake.label}`], { encoding: "utf8" });
      const runsBefore = Number(/^\truns = (\d+)$/m.exec(printed)?.[1]);
      await click("Restart");
      assert.equal(await until(() => probeGranted(`http://127.0.0.1:${PORT}/`, 3000), (p) => p === "granted"), "granted");
      const after = execFileSync("launchctl", ["print", `gui/${process.getuid?.() ?? 0}/${fake.label}`], { encoding: "utf8" });
      assert.equal(Number(/^\truns = (\d+)$/m.exec(after)?.[1]), 1, "a fresh agent, bootstrapped again after the stop");
      assert.ok(runsBefore >= 1);
    });

    test("Quit Granted stops the server, unloads the LaunchAgent, releases the status lock and removes the pid file", async () => {
      await writeFile(helperEnv["GRANTED_HELPER_PID_FILE"], "99999", "utf8");
      await click("Quit Granted");
      assert.equal(await probeGranted(`http://127.0.0.1:${PORT}/`, 3000), "down", "the server is stopped");
      assert.equal(fake.agentLoaded(), false, "nothing left registered with launchd");
      assert.equal(existsSync(macStatusLockPath(fake.statusPath)), false, "the status lock is released");
      assert.equal(existsSync(helperEnv["GRANTED_HELPER_PID_FILE"]), false, "and the pid file is gone");
    });
  },
);

describe(
  "`granted-tray.sh stop` against a live menu-bar helper that is slow to shut down",
  {
    skip:
      (process.platform !== "darwin" || !existsSync(MENUBAR_PKG) || !hasSwift() || !inAquaSession()) &&
      "macOS with the Xcode Command Line Tools and a GUI session only, run from installer/",
  },
  () => {
    /**
     * REGRESSION. This is the one shutdown nothing else here exercises: a plain
     * `stop` (no --server-only) run from OUTSIDE, against a helper started the
     * real way — granted-tray.sh's own start_helper, `nohup <binary> &`, a real
     * process with a real pid file, not GRANTED_MENUBAR_HELPER=none and not the
     * self-test.
     *
     * That stop is a two-step shutdown, not one. SIGTERM makes the helper run a
     * whole `granted-tray.sh stop --server-only` of its own, and only when that
     * returns does it release its `<status>.lock.d` directory and remove its
     * pid file. stop_helper used to allow 10 seconds for all of it, while the
     * nested stop_server it triggers can take two 15-second waits — so a server
     * that was merely slow to exit got the helper SIGKILLed partway through its
     * own cleanup, and its lock directory was left behind for good (nothing
     * else knows where it is, and the next helper's createDirectory over it
     * fails silently). Verified on real hardware before the fix: lock directory
     * leaked; after it: gone.
     *
     * This is also the only test that puts a REAL icon on the menu bar of the
     * machine running it. It is there for the length of this describe block and
     * no longer: the test itself asserts the helper exited, and the teardown
     * SIGKILLs the recorded pid whatever the test did.
     */
    // Longer than stop_helper's old 10-second deadline, so the bug is actually
    // reached, and shorter than stop_server's own 15-second wait, so the whole
    // shutdown still finishes promptly rather than timing out.
    const STOP_DELAY_MS = 14_000;
    let fake: FakeInstall;

    before(async () => {
      await execFileAsync("swift", ["build", "-c", "release", "--package-path", MENUBAR_PKG], { timeout: 10 * 60_000 });
      fake = await setUpFakeInstall({ helper: helperBinary(), stopDelayMs: STOP_DELAY_MS });
      await execFileAsync("/bin/bash", [fake.trayScript, "start", "--port", String(PORT)], {
        env: { ...process.env, ...fake.env },
        timeout: 180_000,
      });
      assert.equal(await until(() => probeGranted(`http://127.0.0.1:${PORT}/`, 3000), (p) => p === "granted"), "granted");
    });

    after(async () => {
      await fake.cleanup();
    });

    test("the helper is really running, from start_helper's own nohup path", async () => {
      assert.ok(existsSync(fake.helperPidFile), "start_helper wrote a pid file");
      const pid = Number(readFileSync(fake.helperPidFile, "utf8").trim());
      assert.ok(Number.isInteger(pid) && pid > 0, "start_helper recorded the helper's pid");
      assert.doesNotThrow(() => process.kill(pid, 0), "and that process is alive");
      // It took the installer's own status lock, which is what a plain `stop`
      // must get it to release again.
      assert.equal(
        await until(() => Promise.resolve(existsSync(macStatusLockPath(fake.statusPath))), (there) => there, 60_000),
        true,
        "the helper holds the <status>.lock.d directory",
      );
    });

    test("stop waits for the helper's whole shutdown, so the status lock and the pid file are both really gone", async () => {
      const pid = Number(readFileSync(fake.helperPidFile, "utf8").trim());
      const startedAt = Date.now();
      await execFileAsync("/bin/bash", [fake.trayScript, "stop", "--port", String(PORT)], {
        env: { ...process.env, ...fake.env },
        timeout: 180_000,
      });
      const elapsed = Date.now() - startedAt;

      // The shutdown really did outlast the old 10-second deadline — without
      // this the rest could pass for the wrong reason, on a server that simply
      // stopped quickly.
      assert.ok(elapsed > 10_000, `the slow shutdown must outlast the old deadline (took ${elapsed}ms)`);
      assert.throws(() => process.kill(pid, 0), "the helper exited");
      // The two things only the helper's own cleanup removes. A leaked lock
      // directory is the bug: permanent, and invisible to everything but this.
      assert.equal(existsSync(macStatusLockPath(fake.statusPath)), false, "the status lock directory is released, not leaked");
      assert.equal(existsSync(fake.helperPidFile), false, "and the pid file is gone");
      // And the stop did what a stop is for.
      assert.equal(await probeGranted(`http://127.0.0.1:${PORT}/`, 3000), "down", "the server is stopped");
      assert.equal(fake.agentLoaded(), false, "nothing left registered with launchd");
    });
  },
);
